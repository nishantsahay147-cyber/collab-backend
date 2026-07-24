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
  if (!value) return '—'
  try {
    return new Date(value).toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  } catch {
    return '—'
  }
}

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
  projectTitle,
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
      doc.image(templatePath, 0, 0, { fit: [pageWidth, pageHeight], align: 'center', valign: 'center' })
    } else {
      doc.rect(20, 20, pageWidth - 40, pageHeight - 40).lineWidth(2).stroke('#6C5CE7')
    }

    const certY = pageHeight * 0.40
    const workY = pageHeight * 0.56
    const nameSize = 34
    const nameY = Math.round(((certY + 14) + workY - nameSize) / 2) - 8

    centerText('Startup Execution Certificate', pageHeight * 0.30, 24, 'Times-Bold')
    centerText('This certifies that', certY, 14)
    centerText(userName, nameY, nameSize, 'Times-Italic')
    centerText(`served as ${memberRole} for the startup`, workY, 13)
    centerText(`"${projectTitle}"`, pageHeight * 0.60, 16, 'Times-Italic')
    centerText(`Status: ${projectStatus} | Stage achieved: ${stageAchieved} | Milestones completed: ${milestonesCompleted}`, pageHeight * 0.64, 12)
    centerText(contributionSummary, pageHeight * 0.68, 11)

    if (collegeName) {
      centerText(`College: ${collegeName.toUpperCase()}`, pageHeight * 0.74, 12)
    }

    const footerY1 = pageHeight * 0.90
    const footerY2 = pageHeight * 0.93
    centerText(`Certificate ID: ${certificateId}`, footerY1, 9, 'Times-Roman', '#374151')
    centerText(`SHA256: ${verificationHash || 'pending'}`, pageHeight * 0.875, 8, 'Times-Roman', '#374151')
    centerText(`Verify: ${verificationUrl || buildVerificationUrl(certificateId)}`, footerY2, 9, 'Times-Roman', '#374151')

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
    const role = userId?.toString?.() === project.owner?.toString?.() ? 'Startup Lead' : 'Startup Team Member'
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
      projectTitle: startupName,
      collegeName: project.college?.name,
      issuedAt,
      certificateId,
      memberRole: role,
      contributionSummary,
      milestonesCompleted: milestoneSummary.completed || 0,
      stageAchieved: project.lifecycleStage ? project.lifecycleStage.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Validation',
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
    const role = userId?.toString?.() === project.owner?._id?.toString?.() || userId?.toString?.() === project.owner?.toString?.()
      ? 'Startup Lead'
      : 'Startup Team Member'
    const certificateId = generateCertificateId()
    const verificationHash = createCertificateHash({ memberName, role, startupName, projectId, timestamp })
    const verificationUrl = buildVerificationUrl(certificateId)

    const result = await generateCertificatePdf({
      userName: memberName,
      projectTitle: startupName,
      collegeName: project.college?.name,
      issuedAt,
      certificateId,
      memberRole: role,
      contributionSummary: 'Participated in the Collab pre-incubation startup execution process.',
      milestonesCompleted,
      stageAchieved: project.lifecycleStage ? project.lifecycleStage.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Startup Execution',
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
