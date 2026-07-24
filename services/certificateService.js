const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const PDFDocument = require('pdfkit')
const Certificate = require('../models/Certificate')

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

const formatDate = (value) => {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  } catch {
    return '-'
  }
}

const toId = (value) => String(value?._id || value?.id || value || '')

const isProjectOwner = (project, userId) => toId(project?.owner) === toId(userId)

const formatStage = (stage, fallback = 'Startup Execution') =>
  String(stage || fallback)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

const buildVerificationUrl = (certificateId) => {
  const appBase = process.env.FRONTEND_URL || process.env.PUBLIC_APP_BASE || 'https://www.joincollab.org'
  return `${appBase.replace(/\/$/, '')}/verify/${certificateId}`
}

const generateCertificateId = () =>
  `COLLAB-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`

const createCertificateHash = ({ memberName, role, startupName, projectId, timestamp }) =>
  crypto
    .createHash('sha256')
    .update([memberName, role, startupName, projectId, timestamp].map((value) => String(value || '')).join('|'))
    .digest('hex')

const generateCertificatePdf = async ({
  userName,
  userEmail,
  projectTitle,
  projectId,
  collegeName,
  issuedAt,
  certificateId,
  memberRole = 'Startup Team Member',
  contributionSummary = 'Contributed to startup execution inside Collab.',
  milestonesCompleted = 0,
  stageAchieved = 'Validation',
  projectStatus = 'In Progress',
  verificationHash = '',
  verificationUrl
}) => {
  const uploadsRoot = path.join(__dirname, '..', 'uploads')
  const certificatesDir = path.join(uploadsRoot, 'certificates')
  ensureDir(certificatesDir)

  const filename = `startup-execution-certificate-${certificateId}.pdf`
  const filePath = path.join(certificatesDir, filename)

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 })
    const stream = fs.createWriteStream(filePath)
    doc.pipe(stream)

    const pageWidth = doc.page.width
    const pageHeight = doc.page.height
    const contentX = 60
    const contentWidth = pageWidth - 120

    const centerText = (text, y, size, font = 'Times-Roman', color = '#111827') => {
      doc.font(font).fontSize(size).fillColor(color)
      doc.text(text, contentX, y, { width: contentWidth, align: 'center' })
    }

    const templatePath = path.join(__dirname, '..', 'assets', 'certificate-template.png')
    if (fs.existsSync(templatePath)) {
      doc.image(templatePath, 0, 0, { width: pageWidth, height: pageHeight })
    } else {
      doc.rect(20, 20, pageWidth - 40, pageHeight - 40).lineWidth(2).stroke('#6C5CE7')
    }

    doc.rect(190, 128, pageWidth - 380, 46).fill('#fafbff')
    centerText('STARTUP EXECUTION CERTIFICATE', 132, 25, 'Times-Bold', '#111827')
    centerText('This certificate confirms verified participation in the COLLAB pre-incubation startup process.', 178, 12, 'Times-Roman', '#374151')
    centerText(userName || 'Team Member', 224, 34, 'Times-Italic', '#111827')
    centerText(userEmail || 'email unavailable', 263, 11, 'Times-Roman', '#4b5563')
    centerText(`served as ${memberRole} for`, 292, 13, 'Times-Roman', '#374151')
    centerText(projectTitle || 'Startup Venture', 322, 22, 'Times-Bold', '#111827')

    const detailY = 372
    doc.roundedRect(116, detailY, pageWidth - 232, 86, 12).lineWidth(1).strokeColor('#d8d6ff').stroke()
    doc.font('Times-Bold').fontSize(10).fillColor('#111827')
    doc.text('PROJECT STATUS', 146, detailY + 18)
    doc.text('STAGE ACHIEVED', 322, detailY + 18)
    doc.text('MILESTONES', 516, detailY + 18)
    doc.text('ISSUED ON', 656, detailY + 18)
    doc.font('Times-Roman').fontSize(12).fillColor('#374151')
    doc.text(projectStatus, 146, detailY + 42, { width: 130 })
    doc.text(stageAchieved, 322, detailY + 42, { width: 150 })
    doc.text(String(milestonesCompleted), 516, detailY + 42, { width: 90 })
    doc.text(formatDate(issuedAt), 656, detailY + 42, { width: 115 })

    centerText(contributionSummary, 478, 11, 'Times-Roman', '#374151')
    if (collegeName) centerText(`Institution: ${collegeName}`, 512, 11, 'Times-Roman', '#374151')

    doc.font('Times-Roman').fontSize(8).fillColor('#374151')
    doc.text(`Project ID: ${projectId || 'unavailable'}`, 62, pageHeight - 72, { width: 230 })
    doc.text(`Certificate ID: ${certificateId}`, 62, pageHeight - 56, { width: 230 })
    doc.text(`SHA256: ${verificationHash || 'pending'}`, 310, pageHeight - 72, { width: 260 })
    doc.text(`Verify: ${verificationUrl || buildVerificationUrl(certificateId)}`, 310, pageHeight - 56, { width: 360 })

    doc.end()
    stream.on('finish', resolve)
    stream.on('error', reject)
  })

  return {
    filename,
    relativePath: `/uploads/certificates/${filename}`,
    certificateId,
    filePath
  }
}

const saveCertificateRecords = async (records = []) => {
  if (!records.length) return
  try {
    await Certificate.insertMany(records, { ordered: false })
  } catch (error) {
    // Certificate downloads should not fail only because an audit record already exists.
    if (error?.code !== 11000) throw error
    console.warn('Certificate record duplicate skipped:', error.message)
  }
}

const generateValidationCertificates = async ({ project, members, milestoneSummary = {}, contributionSummaries = new Map() }) => {
  const issuedAt = new Date()
  const certificates = []

  for (const member of members) {
    const certificateId = generateCertificateId()
    const userId = member._id || member.id || member
    const userName = member.name || 'Team Member'
    const role = isProjectOwner(project, userId) ? 'Startup Lead' : 'Startup Team Member'
    const contributionSummary = contributionSummaries.get?.(userId?.toString?.()) || 'Contributed to startup execution, validation preparation, and incubation readiness work.'
    const timestamp = issuedAt.toISOString()
    const startupName = project.title
    const verificationHash = createCertificateHash({
      memberName: userName,
      role,
      startupName,
      projectId: project._id,
      timestamp
    })
    const verificationUrl = buildVerificationUrl(certificateId)
    const result = await generateCertificatePdf({
      userName: member.name || 'Team Member',
      userEmail: member.email || '',
      projectTitle: startupName,
      projectId: project._id,
      collegeName: project.college?.name,
      issuedAt,
      certificateId,
      memberRole: role,
      contributionSummary,
      milestonesCompleted: milestoneSummary.completed || 0,
      stageAchieved: formatStage(project.lifecycleStage, 'Validation'),
      projectStatus: project.lifecycleStage === 'incubation_ready' ? 'Completed' : 'In Progress',
      verificationHash,
      verificationUrl
    })
    certificates.push({
      certificateId,
      user: userId,
      userName,
      url: result.relativePath,
      filename: result.filename,
      issuedAt,
      role,
      startupName,
      projectId: project._id,
      timestamp,
      verificationHash,
      verificationUrl
    })
  }


  if (certificates.length) {
    await saveCertificateRecords(
      certificates.map((cert) => ({
        certificateId: cert.certificateId,
        project: project._id,
        user: cert.user,
        college: project.college || null,
        projectTitle: project.title,
        userName: cert.userName,
        role: cert.role,
        collegeName: project.college?.name || null,
        issuedAt: cert.issuedAt,
        url: cert.url,
        filename: cert.filename,
        startupName: cert.startupName,
        projectStatus: project.lifecycleStage === 'incubation_ready' ? 'Completed' : 'In Progress',
        verificationHash: cert.verificationHash,
        verificationUrl: cert.verificationUrl,
        verificationTimestamp: cert.timestamp
      }))
    )
  }

  return certificates
}

const generateProjectCertificates = async ({ project, members, milestonesCompleted = 0, persist = true }) => {
  const issuedAt = new Date()
  const timestamp = issuedAt.toISOString()
  const startupName = project.title
  const projectId = project._id
  const projectStatus = project.lifecycleStage === 'incubation_ready' ? 'Completed' : 'In Progress'
  const certificates = []

  for (const member of members) {
    const userId = member._id || member.id || member
    const memberName = member.name || 'Team Member'
    const role = isProjectOwner(project, userId) ? 'Startup Lead' : 'Startup Team Member'
    const certificateId = generateCertificateId()
    const verificationHash = createCertificateHash({ memberName, role, startupName, projectId, timestamp })
    const verificationUrl = buildVerificationUrl(certificateId)

    const result = await generateCertificatePdf({
      userName: memberName,
      userEmail: member.email || '',
      projectTitle: startupName,
      projectId,
      collegeName: project.college?.name,
      issuedAt,
      certificateId,
      memberRole: role,
      contributionSummary: 'Participated in the Collab pre-incubation startup execution process.',
      milestonesCompleted,
      stageAchieved: formatStage(project.lifecycleStage, 'Startup Execution'),
      projectStatus,
      verificationHash,
      verificationUrl
    })

    const certificate = {
      certificateId,
      user: userId,
      userName: memberName,
      role,
      startupName,
      projectId,
      timestamp,
      verificationHash,
      verificationUrl,
      url: result.relativePath,
      filename: result.filename,
      filePath: result.filePath,
      issuedAt
    }
    certificates.push(certificate)
  }

  if (persist && certificates.length) {
    await saveCertificateRecords(
      certificates.map((cert) => ({
        certificateId: cert.certificateId,
        project: project._id,
        user: cert.user,
        college: project.college || null,
        projectTitle: project.title,
        userName: cert.userName,
        role: cert.role,
        collegeName: project.college?.name || null,
        issuedAt: cert.issuedAt,
        url: cert.url,
        filename: cert.filename,
        startupName: cert.startupName,
        projectStatus,
        verificationHash: cert.verificationHash,
        verificationUrl: cert.verificationUrl,
        verificationTimestamp: cert.timestamp
      }))
    )
  }

  return certificates
}

module.exports = {
  generateValidationCertificates,
  generateProjectCertificates,
  buildVerificationUrl,
  createCertificateHash
}
