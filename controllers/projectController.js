const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const PDFDocument = require('pdfkit')
const mongoose = require('mongoose')
const Project = require('../models/Project')
const Milestone = require('../models/Milestone')
const ContributionLog = require('../models/ContributionLog')
const ProjectAccessLog = require('../models/ProjectAccessLog')
const User = require('../models/User')
const { createNotification } = require('./notificationController')
const { applyUserStats, POINTS, computeBadges } = require('../utils/points')
const { sendEmail } = require('../services/emailService')
const { generateValidationCertificates, generateProjectCertificates, buildVerificationUrl } = require('../services/certificateService')
const { createStartupPackageZip, createZipBuffer } = require('../services/exportService')
const { logProjectAccess, ACCESS_TYPES } = require('../services/projectAccessLogger')
const { logSecurityEvent } = require('../middleware/securityLogger')
const {
  normalizeLifecycleStage,
  normalizeLifecycleFilter,
  getLifecycleLabel,
  getLifecycleProgress,
  getNextLifecycleStage,
  inferLifecycleStage,
  canTransitionLifecycle,
  updateLifecycleStage
} = require('../utils/ventureLifecycle')

const toId = (value) => (value ? value.toString() : '')
const FILE_LINK_TTL_SECONDS = Math.max(60, parseInt(process.env.FILE_LINK_TTL_SECONDS || '900', 10) || 900)
if (process.env.NODE_ENV === 'production' && !process.env.FILE_ACCESS_SECRET) {
  throw new Error('FILE_ACCESS_SECRET is required in production')
}
const FILE_ACCESS_SECRET = process.env.FILE_ACCESS_SECRET || process.env.JWT_SECRET || 'collab-dev-file-access-secret'
const PUBLIC_API_BASE = (process.env.PUBLIC_API_BASE || 'https://api.joincollab.org').replace(/\/$/, '')
const PROJECT_VISIBILITY = new Set(['private', 'college', 'global'])
const REVIEWABLE_LIFECYCLE_STAGES = new Set(['building', 'mvp', 'validation'])
const ACTIVE_LIFECYCLE_STAGES = new Set(['idea', 'planning', 'building', 'mvp', 'validation', 'pivoted'])
const TEAM_CHECK_IN_OPTIONS = new Set([
  'strong_momentum',
  'facing_blockers',
  'needs_team_decision',
  'need_contributors',
  'pivoting',
  'preparing_launch'
])

const createIdeaFingerprint = ({ title, shortPitch, description, executionPlan, category, ownerId }) => {
  const normalized = [
    title || '',
    shortPitch || '',
    description || '',
    executionPlan || '',
    category || '',
    ownerId || ''
  ]
    .map((value) => String(value).trim().toLowerCase())
    .join('|')
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

const createStartupCreationHash = ({ projectName, ownerId, projectId, createdAt }) =>
  crypto
    .createHash('sha256')
    .update([projectName, ownerId, projectId, createdAt].map((value) => String(value || '')).join('|'))
    .digest('hex')

const ensureStartupCreationRecord = (project) => {
  if (!project) return null
  const existing = project.startupCreationRecord
  if (existing?.verificationHash) return existing
  const createdAt = project.createdAt || new Date()
  const ownerId = toId(project.owner?._id || project.owner)
  const projectId = toId(project._id || project.id)
  return {
    projectName: project.title || '',
    owner: ownerId,
    createdAt,
    projectId,
    verificationHash: createStartupCreationHash({
      projectName: project.title,
      ownerId,
      projectId,
      createdAt
    })
  }
}

const createPdfBuffer = (draw) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ margin: 48, size: 'A4' })
  const chunks = []
  doc.on('data', (chunk) => chunks.push(chunk))
  doc.on('end', () => resolve(Buffer.concat(chunks)))
  doc.on('error', reject)
  draw(doc)
  doc.end()
})

const createFileSignature = ({ projectId, fileId, userId, expiresAt }) =>
  crypto
    .createHmac('sha256', FILE_ACCESS_SECRET)
    .update(`${projectId}:${fileId}:${userId}:${expiresAt}`)
    .digest('hex')

const buildSignedFileUrl = ({ projectId, fileId, userId }) => {
  if (!projectId || !fileId || !userId) return ''
  const expiresAt = Date.now() + FILE_LINK_TTL_SECONDS * 1000
  const sig = createFileSignature({
    projectId: projectId.toString(),
    fileId: fileId.toString(),
    userId: userId.toString(),
    expiresAt
  })
  return `${PUBLIC_API_BASE}/api/projects/${projectId}/files/${fileId}/download?exp=${expiresAt}&sig=${sig}`
}

const verifyFileSignature = ({ projectId, fileId, userId, expiresAt, sig }) => {
  if (!projectId || !fileId || !userId || !expiresAt || !sig) return false
  const expNumber = Number(expiresAt)
  if (!Number.isFinite(expNumber) || expNumber < Date.now()) return false

  const expected = createFileSignature({
    projectId: projectId.toString(),
    fileId: fileId.toString(),
    userId: userId.toString(),
    expiresAt: expNumber
  })

  const expectedBuffer = Buffer.from(expected, 'utf8')
  const providedBuffer = Buffer.from(String(sig), 'utf8')
  if (expectedBuffer.length !== providedBuffer.length) return false
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}

const normalizeLabel = (value) => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

const normalizeLabelList = (items) => {
  const list = Array.isArray(items) ? items : items ? [items] : []
  const normalized = list
    .map((item) => normalizeLabel(typeof item === 'string' ? item : ''))
    .filter(Boolean)
  return [...new Set(normalized)]
}

const normalizePlainText = (value, maxLength = 500) => {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

const normalizeLongText = (value, maxLength = 3000) => {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

const normalizeValidationAssumptions = (items) => {
  const list = Array.isArray(items) ? items : items ? [items] : []
  const normalized = list
    .map((item) => normalizeLongText(typeof item === 'string' ? item : String(item), 300))
    .filter(Boolean)
  return [...new Set(normalized)].slice(0, 30)
}

const normalizeValidationTasks = (items) => {
  const list = Array.isArray(items) ? items : []

  return list
    .map((item) => {
      if (typeof item === 'string') {
        return {
          taskId: new mongoose.Types.ObjectId().toString(),
          title: normalizePlainText(item, 180),
          status: 'pending',
          dueDate: undefined,
          updatedAt: new Date(),
          completedAt: undefined
        }
      }

      const title = normalizePlainText(item?.title || '', 180)
      if (!title) return null

      const status = item?.status === 'completed' ? 'completed' : 'pending'
      const dueDate = item?.dueDate ? new Date(item.dueDate) : undefined
      const completedAt = status === 'completed'
        ? (item?.completedAt ? new Date(item.completedAt) : new Date())
        : undefined

      return {
        taskId: item?.taskId || new mongoose.Types.ObjectId().toString(),
        title,
        status,
        dueDate: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : undefined,
        updatedAt: new Date(),
        completedAt
      }
    })
    .filter(Boolean)
    .slice(0, 100)
}

const VALIDATION_EVIDENCE_KINDS = new Set([
  'screenshot',
  'survey_pdf',
  'interview_notes',
  'feedback_form',
  'recording',
  'testing_proof',
  'survey',
  'interview',
  'waitlist',
  'feedback',
  'experiment',
  'insight',
  'other'
])

const normalizeValidationEvidence = (items) => {
  const list = Array.isArray(items) ? items : []

  return list
    .map((item) => {
      if (!item) return null

      const title = normalizePlainText(item?.title || '', 180)
      if (!title) return null

      const kind = VALIDATION_EVIDENCE_KINDS.has(item?.kind) ? item.kind : 'other'
      const summary = normalizeLongText(item?.summary || '', 1500)
      const link = normalizePlainText(item?.link || '', 1000)

      return {
        evidenceId: item?.evidenceId || new mongoose.Types.ObjectId().toString(),
        kind,
        title,
        summary,
        link,
        createdAt: item?.createdAt ? new Date(item.createdAt) : new Date()
      }
    })
    .filter(Boolean)
    .slice(0, 300)
}

const normalizeMomentumStatus = (value) => {
  if (value === 'need_contributors') return 'needs_team_decision'
  if (TEAM_CHECK_IN_OPTIONS.has(value)) return value
  return 'needs_team_decision'
}

const getProjectLifecycle = (project) => normalizeLifecycleStage(project?.lifecycleStage || inferLifecycleStage(project))

const setProjectLifecycle = (project, nextStage) => updateLifecycleStage(project, nextStage)

const isLegacyValidationLocked = (project) => project?.validation?.validationStatus === 'in_review'

const isValidationOutcomeFailed = (project) => project?.validation?.validationStatus === 'failed'

const isValidationOutcomePassed = (project) =>
  project?.validation?.validationStatus === 'passed' || getProjectLifecycle(project) === 'incubation_ready'

const toReadinessScore = (value, fallback = 0) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return Math.max(0, Math.min(100, Math.round(fallback)))
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

const normalizeBlockers = (value) => {
  const list = Array.isArray(value) ? value : value ? [value] : []
  const cleaned = list
    .map((item) => (typeof item === 'string' ? item.trim() : String(item || '').trim()))
    .filter(Boolean)
    .slice(0, 20)
  return [...new Set(cleaned)]
}

const normalizeDependencyIds = (value) => {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return [...new Set(
    list
      .map((item) => (typeof item === 'string' ? item : String(item || '')).trim())
      .filter((item) => mongoose.Types.ObjectId.isValid(item))
  )].slice(0, 20)
}

const normalizeBlockerDetails = (value, requesterId) => {
  const validTypes = new Set(['technical', 'design', 'validation', 'team', 'contributor'])
  const validStatuses = new Set(['open', 'resolved'])
  const list = Array.isArray(value) ? value : []

  return list
    .map((item) => {
      const description = normalizePlainText(item?.description || '', 500)
      if (!description) return null
      const status = validStatuses.has(item?.status) ? item.status : 'open'
      const resolvedAt = status === 'resolved'
        ? (item?.resolvedAt ? new Date(item.resolvedAt) : new Date())
        : undefined

      return {
        blockerId: normalizePlainText(item?.blockerId || '', 80) || new mongoose.Types.ObjectId().toString(),
        type: item?.type === 'contributor' ? 'team' : validTypes.has(item?.type) ? item.type : 'technical',
        description,
        status,
        createdBy: item?.createdBy || requesterId,
        createdAt: item?.createdAt ? new Date(item.createdAt) : new Date(),
        resolvedAt: resolvedAt && !Number.isNaN(resolvedAt.getTime()) ? resolvedAt : undefined
      }
    })
    .filter(Boolean)
    .slice(0, 50)
}

const getOpenBlockerCount = (milestones = []) => milestones.reduce((count, milestone) => {
  const textBlockers = Array.isArray(milestone.blockers) ? milestone.blockers.length : 0
  const typedBlockers = Array.isArray(milestone.blockerDetails)
    ? milestone.blockerDetails.filter((blocker) => blocker.status !== 'resolved').length
    : 0
  return count + textBlockers + typedBlockers
}, 0)

const getContinuationRecommendations = ({ project, milestones = [] }) => {
  const lifecycleStage = getProjectLifecycle(project)
  const openBlockers = getOpenBlockerCount(milestones)
  const completedMilestones = milestones.filter((milestone) => milestone.status === 'completed').length
  const readinessScore = Number(project?.readinessScore || 0)
  const validationStatus = project?.validation?.validationStatus || 'pending'
  const recommendations = []

  if (openBlockers > 0) recommendations.push('Resolve active blockers before increasing scope.')
  if (project?.teamMembers?.length < Math.max(1, Number(project?.numberOfTeammates || 1))) {
    recommendations.push('Confirm your internal team roles before increasing scope.')
  }
  if (['idea', 'planning'].includes(lifecycleStage)) {
    recommendations.push('Turn the startup concept into milestones, feature scope, roles, and a timeline.')
  }
  if (['building', 'mvp'].includes(lifecycleStage) && completedMilestones < 2) {
    recommendations.push('Create concrete build and MVP milestones with owners.')
  }
  if (validationStatus === 'failed' || lifecycleStage === 'pivoted') {
    recommendations.push('Use self-conducted feedback to pivot or relaunch validation with sharper evidence.')
  }
  if (readinessScore >= 75 || lifecycleStage === 'validation') {
    recommendations.push('Prepare incubation materials, validation evidence, and pitch structure.')
  }
  if (recommendations.length === 0) recommendations.push('Continue toward the next guided pipeline milestone.')

  return recommendations
}

const buildContinuationPlan = ({ project, milestones = [] }) => ({
  lifecycleStage: getProjectLifecycle(project),
  readinessScore: toReadinessScore(project?.readinessScore || 0),
  momentumStatus: normalizeMomentumStatus(project?.momentumStatus),
  recommendations: getContinuationRecommendations({ project, milestones }),
  paths: [
    { action: 'continue_planning', label: 'Continue Planning', targetStage: 'planning' },
    { action: 'continue_building', label: 'Continue Building', targetStage: 'building' },
    { action: 'extend_mvp', label: 'Refine MVP', targetStage: 'mvp' },
    { action: 'relaunch_validation', label: 'Run Validation', targetStage: 'validation' },
    { action: 'prepare_incubation', label: 'Prepare For Incubation', targetStage: 'incubation_ready' },
    { action: 'pivot_venture', label: 'Pivot Venture', targetStage: 'pivoted' },
    { action: 'archive_venture', label: 'Archive Venture', targetStage: 'archived' }
  ]
})

const formatPacketDate = (value) => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

const getStartupProblem = (project = {}) => (
  project.validation?.workspace?.problemStatement
  || project.techProduct?.problem
  || project.businessStartup?.marketGap
  || project.description
  || project.shortPitch
  || ''
)

const getStartupTargetUsers = (project = {}) => (
  project.validation?.workspace?.targetUsers
  || project.techProduct?.targetUsers
  || project.businessStartup?.targetAudience
  || project.servicesOperations?.targetClients
  || ''
)

const buildIncubationPacket = ({ project, milestones = [], logs = [] }) => {
  const lifecycleStage = getProjectLifecycle(project)
  const pipeline = project.pipeline || {}
  const foundation = pipeline.foundation || {}
  const purpose = pipeline.purpose || {}
  const mvp = pipeline.mvp || {}
  const incubation = pipeline.incubation || {}
  const validationWorkspace = project.validation?.workspace || {}
  const completedMilestones = milestones.filter((milestone) => milestone.status === 'completed')
  const openBlockers = getOpenBlockerCount(milestones)
  const evidence = validationWorkspace.evidence || []
  const files = project.files || []
  const members = [
    project.owner,
    ...(project.teamMembers || []).filter((member) => toId(member) !== toId(project.owner))
  ].filter(Boolean)

  const packetItems = [
    { key: 'startupSummary', title: 'Startup Summary', ready: Boolean(project.title && project.shortPitch) },
    { key: 'problemStatement', title: 'Problem Statement', ready: Boolean(getStartupProblem(project)) },
    { key: 'validationReport', title: 'Validation Report', ready: evidence.length > 0 || (validationWorkspace.tasks || []).length > 0 },
    { key: 'teamDetails', title: 'Team Details', ready: members.length > 0 },
    { key: 'executionTimeline', title: 'Execution Timeline', ready: milestones.length > 0 || logs.length > 0 },
    { key: 'milestoneHistory', title: 'Milestone History', ready: milestones.length > 0 },
    { key: 'mvpSummary', title: 'MVP Summary', ready: ['mvp', 'validation', 'incubation_ready'].includes(lifecycleStage) },
    { key: 'prototypeShowcase', title: 'Prototype Showcase', ready: files.length > 0 || Boolean(project.validation?.demoLink) },
    { key: 'validationEvidence', title: 'Validation Evidence', ready: evidence.length > 0 || (project.validation?.sharedFiles || []).length > 0 },
    { key: 'pitchDeckStructure', title: 'Pitch Deck Structure', ready: true },
    { key: 'applicationPacket', title: 'Incubation Application Packet', ready: Number(project.readinessScore || 0) >= 70 },
    { key: 'executionReports', title: 'Execution Reports', ready: logs.length > 0 }
  ]

  return {
    generatedAt: new Date().toISOString(),
    readinessScore: toReadinessScore(project.readinessScore || 0),
    stage: {
      value: lifecycleStage,
      label: getLifecycleLabel(lifecycleStage),
      progress: getLifecycleProgress(lifecycleStage)
    },
    summary: {
      startupName: project.title,
      category: project.category,
      tagline: foundation.tagline || project.shortPitch || '',
      whyThisMatters: purpose.impactStatement || project.shortPitch,
      problemStatement: getStartupProblem(project),
      targetUsers: getStartupTargetUsers(project),
      currentStage: getLifecycleLabel(lifecycleStage),
      nextStage: getNextLifecycleStage(lifecycleStage)
        ? getLifecycleLabel(getNextLifecycleStage(lifecycleStage))
        : 'Ready to submit',

      elevatorPitch: project.shortPitch || '',
      descriptorWords: foundation.descriptorWords || project.tags || [],
      founderInspiration: purpose.founderInspiration || '',
      founderName: project.owner?.name || '',
      founderEmail: project.owner?.email || '',
      collegeName: project.owner?.college?.name || project.college?.name || '',
      course: project.owner?.course || ''
    },
    planning: {
      goals: project.executionPlan || mvp.roadmap || '',
      featureScope: project.techProduct?.features || project.designCreative?.deliverables || [],
      roles: project.rolesNeeded || [],
      skills: project.skillsRequired || [],
      readinessNotes: pipeline.readiness?.notes || ''
    },
    teamDetails: {
      founder: {
        name: project.owner?.name || '',
        email: project.owner?.email || '',
        role: 'Startup Lead',
        collegeName: project.owner?.college?.name || project.college?.name || '',
        course: project.owner?.course || ''
      },

      members: members.map((member) => ({
        id: toId(member?._id || member),
        name: member?.name || 'Team Member',
        email: member?.email || '',
        role:
          toId(member?._id || member) === toId(project.owner)
            ? 'Startup Lead'
            : 'Team Member'
      }))
    },
    milestoneHistory: milestones.map((milestone) => ({
      title: milestone.title,
      status: milestone.status,
      priority: milestone.priority,
      lifecycleStage: getLifecycleLabel(milestone.lifecycleStage),
      owner: milestone.owner?.name || 'Unassigned',
      dueDate: formatPacketDate(milestone.dueDate),
      blockers: [
        ...(milestone.blockers || []),
        ...(milestone.blockerDetails || []).filter((blocker) => blocker.status !== 'resolved').map((blocker) => blocker.description)
      ].filter(Boolean)
    })),
    validationReport: {
      status: project.validation?.validationStatus || 'pending',
      confidenceScore: validationWorkspace.confidenceScore || 0,
      questions: [
        { question: 'Who did you speak to?', answer: validationWorkspace.whoSpokenTo || '' },
        { question: 'What repeated problems appeared?', answer: validationWorkspace.repeatedProblems || '' },
        { question: 'What surprised you?', answer: validationWorkspace.surprisingInsights || '' },
        { question: 'Would users actually use or pay for this?', answer: validationWorkspace.useOrPaySignal || '' },
        { question: 'What changed after feedback?', answer: validationWorkspace.feedbackChanges || '' }
      ],
      tasks: validationWorkspace.tasks || [],
      evidence
    },
    prototypeShowcase: {
      demoLink: project.validation?.demoLink || mvp.demoLinks?.[0] || '',
      demoNotes: project.validation?.demoNotes || '',
      figmaLinks: mvp.figmaLinks || [],
      githubLinks: mvp.githubLinks || [],
      demoLinks: mvp.demoLinks || [],
      files: files.map((file) => ({
        id: toId(file._id || file.filename),
        name: file.originalName,
        type: file.mimetype,
        uploadedAt: formatPacketDate(file.uploadedAt)
      }))
    },
    executionTimeline: logs.map((log) => ({
      action: log.action,
      impact: log.impact,
      contributor: log.contributor?.name || 'Team Member',
      milestone: log.milestoneId?.title || '',
      timestamp: formatPacketDate(log.timestamp || log.createdAt)
    })),
    pitchDeckStructure: [
      'Startup name and one-line summary',
      'Problem and target users',
      'Current solution and MVP scope',
      'Validation evidence and user learnings',
      'Team roles and execution history',
      'Roadmap after incubation support',
      'Ask from the incubation center'
    ],
    incubationAssets: {
      executiveSummary: incubation.executiveSummary || '',
      startupOverview: incubation.startupOverview || '',
      pitchDeckLinks: incubation.pitchDeckLinks || [],
      demoVideoLinks: incubation.demoVideoLinks || []
    },
    checklist: packetItems,
    readinessSignals: {
      completedMilestones: completedMilestones.length,
      totalMilestones: milestones.length,
      openBlockers,
      evidenceCount: evidence.length,
      uploadedAssets: files.length,
      executionLogs: logs.length
    }
  }
}

const logContribution = async ({ projectId, contributor, milestoneId, action, impact }) => {
  if (!projectId || !contributor || !action) return null
  return ContributionLog.create({
    projectId,
    contributor,
    milestoneId: milestoneId && mongoose.Types.ObjectId.isValid(milestoneId) ? milestoneId : undefined,
    action: String(action).trim().slice(0, 200),
    impact: typeof impact === 'string' ? impact.trim().slice(0, 1000) : ''
  })
}

const isViewerTeamMember = (project, viewerId) => {
  if (!viewerId) return false
  return (project.teamMembers || []).some((member) => toId(member._id || member) === viewerId)
}

const sanitizeProjectForViewer = (projectDoc, viewerId) => {
  if (!projectDoc) return null
  const project = projectDoc.toObject({ virtuals: true })
  const ownerId = toId(project.owner?._id || project.owner)
  const isOwner = viewerId && ownerId === viewerId
  const isTeamMember = isViewerTeamMember(project, viewerId)
  const isPrivilegedViewer = Boolean(isOwner || isTeamMember)

  const withDownloadLinks = (files = []) =>
    files.map((file) => {
      const fileId = toId(file?._id || file?.filename)
      return {
        ...file,
        downloadUrl: buildSignedFileUrl({
          projectId: project._id,
          fileId,
          userId: viewerId
        })
      }
    })

  if (!isOwner) {
    project.interestedUsers = []
    project.teamApplications = []
    project.security = undefined
  }

  if (!isPrivilegedViewer) {
    project.teamMembers = (project.teamMembers || []).map((member) => ({
      _id: member._id,
      name: member.name || 'Team Member'
    }))

    // Keep external view focused on a public summary, not the implementation details.
    project.executionPlan = undefined
    project.techProduct = undefined
    project.businessStartup = undefined
    project.designCreative = undefined
    project.marketingContent = undefined
    project.servicesOperations = undefined

    project.files = []
    project.messages = []
    if (project.validation) {
      project.validation.sharedFiles = []
    }
    if (project.owner) {
      const ownerId = project.owner._id || project.owner
      project.owner = {
        _id: ownerId,
        name: project.owner.name || 'Owner'
      }
    }
  }

  if (Array.isArray(project.files) && viewerId) {
    project.files = withDownloadLinks(project.files)
  }

  if (Array.isArray(project.validation?.sharedFiles) && viewerId) {
    project.validation.sharedFiles = withDownloadLinks(project.validation.sharedFiles)
  }

  project.accessWatermark = {
    viewerId: viewerId || 'unknown',
    issuedAt: new Date().toISOString()
  }

  return project
}

const OWNER_DISCOVER_SELECT =
  'name email phone primaryCategory showContactToTeam executionProfile.commitmentLevel executionProfile.roles'

const buildFounderRoleLabel = (ownerDoc = {}) => {
  if (ownerDoc.executionProfile?.commitmentLevel) {
    return ownerDoc.executionProfile.commitmentLevel
  }
  const roles = ownerDoc.executionProfile?.roles
  if (Array.isArray(roles) && roles.length > 0) {
    return roles[0]
  }
  if (ownerDoc.primaryCategory) {
    return `${ownerDoc.primaryCategory} · Founder`
  }
  return 'Startup Founder'
}

const sanitizeProjectForDiscover = (projectDoc, viewerId) => {
  const raw = projectDoc.toObject ? projectDoc.toObject({ virtuals: true }) : projectDoc
  if (!raw) return null
  return {
    _id: raw._id,
    title: raw.title || 'Untitled venture',
    shortPitch: raw.shortPitch || String(raw.description || '').split('\n')[0].slice(0, 200),
    lookingForTeammates: Boolean(raw.lookingForTeammates)
  }
}

const maybeApplyInactivityPenalty = async (project) => {
  if (!project?.buildPhase?.isActive) return

  const lastActivity = project.buildPhase.lastActivity
  if (!lastActivity) return

  const lastPenaltyAt = project.buildPhase.lastPenaltyAt
  const now = Date.now()
  const diff = now - new Date(lastActivity).getTime()

  if (diff < 48 * 60 * 60 * 1000) return
  if (lastPenaltyAt && new Date(lastPenaltyAt).getTime() >= new Date(lastActivity).getTime()) return

  const teamIds = [project.owner, ...(project.teamMembers || [])]
  await Promise.all(
    teamIds.map((id) =>
      applyUserStats(id, {
        points: POINTS.inactivity_penalty,
        inc: { inactivePenalties: 1 },
        touchActive: false
      })
    )
  )

  project.buildPhase.lastPenaltyAt = new Date()
  await project.save()
}

exports.createProject = async (req, res) => {
  try {
    const {
      title,
      shortPitch,
      description,
      category,
      tags,
      rolesNeeded,
      skillsRequired,
      numberOfTeammates,
      visibility,
      lookingForTeammates,
      executionPlan,
      techProduct,
      businessStartup,
      designCreative,
      marketingContent,
      servicesOperations
    } = req.body

    const userId = req.user.userId

    const normalizedTitle = title?.trim()
    const normalizedShortPitch = shortPitch?.trim()
    const normalizedCategory = category?.trim()
    const normalizedExecutionPlan = executionPlan?.trim()
    const normalizedDescription = (description?.trim() || normalizedShortPitch || normalizedTitle || '').trim()

    if (!normalizedTitle || !normalizedShortPitch || !normalizedCategory || !normalizedExecutionPlan) {
      return res.status(400).json({ message: 'Title, short pitch, category, and execution plan are required' })
    }

    const owner = await User.findById(userId).select('college college_id')

    const normalizedSkills = normalizeLabelList(skillsRequired)
    const normalizedRoles = normalizeLabelList(rolesNeeded)
    const normalizedVisibility = PROJECT_VISIBILITY.has(visibility) ? visibility : 'private'
    const ideaFingerprint = createIdeaFingerprint({
      title: normalizedTitle,
      shortPitch: normalizedShortPitch,
      description: normalizedDescription,
      executionPlan: normalizedExecutionPlan,
      category: normalizedCategory,
      ownerId: userId
    })

    const project = new Project({
      title: normalizedTitle,
      shortPitch: normalizedShortPitch,
      description: normalizedDescription,
      category: normalizedCategory,
      tags: (Array.isArray(tags) ? tags : tags ? [tags] : []).filter(Boolean),
      rolesNeeded: normalizedRoles,
      skillsRequired: normalizedSkills,
      numberOfTeammates: Math.min(10, Math.max(1, parseInt(numberOfTeammates, 10) || 1)),
      visibility: normalizedVisibility,
      lookingForTeammates: lookingForTeammates === true || lookingForTeammates === 'true',
      college: owner?.college || owner?.college_id || undefined,
      executionPlan: normalizedExecutionPlan,
      security: {
        ideaFingerprint,
        fingerprintAlgorithm: 'sha256',
        fingerprintVersion: 1,
        fingerprintedAt: new Date()
      },
      owner: userId,
      teamMembers: [userId],
      lifecycleStage: 'idea',
      readinessScore: 10,
      momentumStatus: 'needs_team_decision',
      teamCheckIn: {
        status: 'needs_team_decision',
        note: 'Team setup needs a clear next decision.',
        updatedAt: new Date(),
        updatedBy: userId
      },
      buildPhase: {
        startDate: undefined,
        endDate: undefined,
        isActive: false,
        lastActivity: new Date(),
        totalDurationDays: 0,
        isExtendedTimeline: false,
        extensionCount: 0,
        extensionDaysGranted: 0
      },
      techProduct: category === 'Tech & Product' ? techProduct : undefined,
      businessStartup: category === 'Business & Startup' ? businessStartup : undefined,
      designCreative: category === 'Design & Creative' ? designCreative : undefined,
      marketingContent: category === 'Marketing & Content' ? marketingContent : undefined,
      servicesOperations: category === 'Services & Operations' ? servicesOperations : undefined
    })

    const creationRecordDate = new Date()
    project.startupCreationRecord = {
      projectName: project.title,
      owner: userId,
      createdAt: creationRecordDate,
      projectId: project._id.toString(),
      verificationHash: createStartupCreationHash({
        projectName: project.title,
        ownerId: userId,
        projectId: project._id,
        createdAt: creationRecordDate
      })
    }

    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: userId,
      action: 'Created venture workspace',
      impact: 'Initialized venture lifecycle at idea stage.'
    })

    await applyUserStats(userId, {
      points: POINTS.create_project,
      inc: { projectsCreated: 1 }
    })

    const populatedProject = await Project.findById(project._id).populate('owner', 'name email')

    res.status(201).json({
      message: 'Venture created successfully',
      project: populatedProject
    })
  } catch (error) {
    console.error('Create venture error:', error)
    res.status(500).json({ message: 'Failed to create venture' })
  }
}

exports.getProjects = async (req, res) => {
  try {
    const { college, category, skills, status, lifecycleStage, roles, page = 1, limit = 20 } = req.query
    const parsedLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20))
    const parsedPage = Math.max(1, parseInt(page, 10) || 1)
    const filter = {}
    const viewerId = req.user?.userId ? req.user.userId.toString() : ''
    filter.lifecycleStage = { $ne: 'archived' }

    const lifecycleFilter = lifecycleStage || status
    if (typeof lifecycleFilter === 'string' && lifecycleFilter && lifecycleFilter !== 'all') {
      filter.lifecycleStage = normalizeLifecycleFilter(lifecycleFilter)
    } else {
      filter.lifecycleStage = { $ne: 'archived' }
    }

    if (college && college !== 'all') {
      if (!mongoose.Types.ObjectId.isValid(college)) {
        return res.status(400).json({ message: 'Invalid college filter' })
      }
      filter.college = college
    }

    if (category && category !== 'all') {
      filter.category = category
    }

    if (skills && skills !== 'all') {
      const skillsArray = Array.isArray(skills)
        ? skills
        : skills.split(',').map((skill) => skill.trim()).filter(Boolean)
      if (skillsArray.length > 0) {
        filter.skillsRequired = { $in: normalizeLabelList(skillsArray) }
      }
    }

    if (roles && roles !== 'all') {
      const rolesArray = Array.isArray(roles)
        ? roles
        : roles.split(',').map((role) => role.trim()).filter(Boolean)
      if (rolesArray.length > 0) {
        filter.rolesNeeded = { $in: normalizeLabelList(rolesArray) }
      }
    }

    let projects
    try {
      projects = await Project.find(filter)
        .populate('owner', OWNER_DISCOVER_SELECT)
        .populate('college', 'name type')
        .sort({ createdAt: -1 })
        .limit(parsedLimit)
        .skip((parsedPage - 1) * parsedLimit)
    } catch (populateError) {
      if (populateError?.name === 'CastError' && populateError?.path === 'college') {
        console.warn('Venture college populate failed, falling back without college populate.')
        projects = await Project.find(filter)
          .populate('owner', OWNER_DISCOVER_SELECT)
          .sort({ createdAt: -1 })
          .limit(parsedLimit)
          .skip((parsedPage - 1) * parsedLimit)
      } else {
        throw populateError
      }
    }

    const total = await Project.countDocuments(filter)
    const sanitizedProjects = projects.map((project) => sanitizeProjectForDiscover(project, viewerId))

    res.json({
      projects: sanitizedProjects,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        pages: Math.ceil(total / parsedLimit)
      }
    })
  } catch (error) {
    console.error('Get ventures error:', error)
    res.status(500).json({ message: 'Failed to fetch ventures' })
  }
}

exports.getProjectOptions = async (req, res) => {
  try {
    const [roles, skills] = await Promise.all([
      Project.distinct('rolesNeeded'),
      Project.distinct('skillsRequired')
    ])

    const normalizedRoles = normalizeLabelList(roles)
    const normalizedSkills = normalizeLabelList(skills)

    res.json({ roles: normalizedRoles, skills: normalizedSkills })
  } catch (error) {
    console.error('Get venture options error:', error)
    res.status(500).json({ message: 'Failed to fetch venture options' })
  }
}

exports.getProjectById = async (req, res) => {
  try {
    const { id } = req.params
    const viewerId = req.user?.userId ? req.user.userId.toString() : ''

    const project = await Project.findById(id).populate('college', 'name')
      .populate('owner', 'name email phone lastActive')
      .populate('teamMembers', 'name email phone lastActive')
      .populate('interestedUsers', 'name email phone lastActive')
      .populate('teamApplications.user', 'name email phone lastActive')
      .populate('messages.sender', 'name email')
      .populate('files.uploadedBy', 'name email')
      .populate('validation.sharedFiles.uploadedBy', 'name email')

    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const isOwner = toId(project.owner?._id) === viewerId
    const isTeamMember = isViewerTeamMember(project, viewerId) || isOwner

    if (project.visibility === 'private' && !isOwner && !isTeamMember) {
      return res.status(403).json({ message: 'This venture is visible only to the venture team' })
    }

    if (project.visibility === 'college' && !isOwner && !isTeamMember) {
      const viewer = await User.findById(viewerId).select('college college_id')
      const viewerCollege = (viewer?.college || viewer?.college_id) ? (viewer.college || viewer.college_id).toString() : null
      const projectCollege = project.college ? project.college.toString() : null
      if (viewerCollege && projectCollege && viewerCollege !== projectCollege) {
        return res.status(403).json({ message: 'This venture is visible to its college only' })
      }
    }

    if (isTeamMember) {
      await maybeApplyInactivityPenalty(project)
    }

    if (!project.startupCreationRecord?.verificationHash) {
      project.startupCreationRecord = ensureStartupCreationRecord(project)
      await project.save()
    }

    if (req.query?.audit === 'project_view' && isTeamMember) {
      await logProjectAccess({
        project,
        userId: viewerId,
        accessType: 'project_view',
        metadata: { source: 'workspace' }
      })
    }

    const sanitized = sanitizeProjectForViewer(project, viewerId)

    res.json(sanitized)
  } catch (error) {
    console.error('Get venture error:', error)
    res.status(500).json({ message: 'Failed to fetch venture' })
  }
}

exports.addTeamMember = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId || req.body.requesterId
    const { userId } = req.body

    if (!requesterId || !userId) {
      return res.status(400).json({ message: 'requesterId and userId are required' })
    }

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const maxTeamMembers = project.numberOfTeammates || 0
    const currentTeamCount = (project.teamMembers || []).length

    if (currentTeamCount >= maxTeamMembers) {
      return res.status(400).json({ message: 'Team is full' })
    }

    if (project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only venture owner can add team contributors' })
    }

    const team = (project.teamMembers || []).map((uid) => uid.toString())
    if (team.includes(userId.toString())) {
      return res.status(400).json({ message: 'User already on team' })
    }

    const teammate = await User.findById(userId).select('_id')
    if (!teammate) {
      return res.status(404).json({ message: 'User ID not found' })
    }

    project.teamMembers.push(userId)
    project.interestedUsers = project.interestedUsers.filter((uid) => uid.toString() !== userId.toString())

    const teamCount = (project.teamMembers || []).length
    if (teamCount >= maxTeamMembers && ['idea', 'planning'].includes(getProjectLifecycle(project))) {
      if (!project.buildPhase) {
        project.buildPhase = {}
      }
      setProjectLifecycle(project, 'building')
      project.momentumStatus = 'strong_momentum'
      project.readinessScore = toReadinessScore(project.readinessScore, 28)
      project.teamCheckIn = {
        status: 'strong_momentum',
        note: 'Startup team formed. Build execution started.',
        updatedAt: new Date(),
        updatedBy: requesterId
      }
      project.buildPhase.startDate = new Date()
      project.buildPhase.endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      project.buildPhase.isActive = true
      project.buildPhase.lastActivity = new Date()
      project.buildPhase.totalDurationDays = 14
      project.buildPhase.isExtendedTimeline = false
      project.buildPhase.extensionCount = 0
      project.buildPhase.extensionDaysGranted = 0
    }
    const remainingInterested = [...project.interestedUsers]
    if (teamCount >= maxTeamMembers && remainingInterested.length > 0) {
      await Promise.all(
        remainingInterested.map((participantId) =>
          createNotification(
            participantId,
            'team_full',
            'Team Full',
            `${project.title} is now full.`,
            project._id,
            project.owner,
            false,
            `/project/${project._id}`
          )
        )
      )
      project.interestedUsers = []
    }

    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: requesterId,
      action: 'Added contributor to startup team',
      impact: `${teamCount}/${maxTeamMembers} team slots filled.`
    })

    await applyUserStats(userId, {
      points: POINTS.join_project,
      inc: { projectsJoined: 1 }
    })

    await createNotification(
      userId,
      'join_accepted',
      'Welcome to the team',
      `You have been added to ${project.title}.`,
      project._id,
      project.owner,
      false,
      `/project/${project._id}`
    )

    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')
      .populate('messages.sender', 'name email')
      .populate('files.uploadedBy', 'name email')
      .populate('validation.sharedFiles.uploadedBy', 'name email')

    res.json({ message: 'Team member added', project: populated })
  } catch (error) {
    console.error('Error adding team contributor:', error)
    res.status(500).json({ message: 'Failed to add team contributor' })
  }
}

exports.applyToProjectTeam = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const role = String(req.body.role || '').trim().slice(0, 120)
    const project = await Project.findById(id)
    if (!project) return res.status(404).json({ message: 'Venture not found' })
    if (!project.lookingForTeammates) return res.status(400).json({ message: 'This venture is not accepting teammate applications right now' })
    if (toId(project.owner) === requesterId || (project.teamMembers || []).some((member) => toId(member) === requesterId)) {
      return res.status(400).json({ message: 'You are already part of this venture' })
    }
    const existing = (project.teamApplications || []).find((item) => toId(item.user) === requesterId && item.status === 'pending')
    if (existing) return res.status(400).json({ message: 'Application already pending' })
    project.teamApplications.push({ user: requesterId, role, status: 'pending', createdAt: new Date() })
    if (!(project.interestedUsers || []).some((userId) => toId(userId) === requesterId)) project.interestedUsers.push(requesterId)
    await project.save()
    await createNotification(project.owner, 'team_application', 'New teammate application', `A builder applied for ${role} on ${project.title}.`, project._id, requesterId, true, `/project/${project._id}`)
    res.json({ message: 'Application sent' })
  } catch (error) {
    console.error('Apply teammate error:', error)
    res.status(500).json({ message: 'Failed to apply for this venture' })
  }
}

exports.respondToTeamApplication = async (req, res) => {
  try {
    const { id, applicationId } = req.params
    const requesterId = req.user?.userId
    const { action } = req.body
    const project = await Project.findById(id)
    if (!project) return res.status(404).json({ message: 'Venture not found' })
    if (toId(project.owner) !== requesterId) return res.status(403).json({ message: 'Only the venture owner can respond' })
    const application = project.teamApplications.id(applicationId)
    if (!application) return res.status(404).json({ message: 'Application not found' })
    if (application.status !== 'pending') return res.status(400).json({ message: 'Application already reviewed' })
    const applicantId = toId(application.user)
    if (action === 'accept') {
      const maxTeamMembers = project.numberOfTeammates || 10
      if ((project.teamMembers || []).length >= maxTeamMembers) return res.status(400).json({ message: 'Team is full' })
      if (!(project.teamMembers || []).some((member) => toId(member) === applicantId)) project.teamMembers.push(application.user)
      application.status = 'accepted'
      await createNotification(applicantId, 'join_accepted', 'Application accepted', `You have been added to ${project.title}.`, project._id, project.owner, false, `/project/${project._id}`)
    } else {
      application.status = 'rejected'
      await createNotification(applicantId, 'join_rejected', 'Application reviewed', `${project.title} is not adding you right now.`, project._id, project.owner, false, `/discover`)
    }
    application.decidedAt = new Date()
    project.interestedUsers = (project.interestedUsers || []).filter((userId) => toId(userId) !== applicantId)
    await project.save()
    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')
      .populate('teamApplications.user', 'name email')
    res.json({ message: `Application ${application.status}`, project: populated })
  } catch (error) {
    console.error('Respond teammate error:', error)
    res.status(500).json({ message: 'Failed to review application' })
  }
}

exports.updateProjectRequirements = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const { rolesNeeded, skillsRequired, numberOfTeammates, visibility, lookingForTeammates } = req.body

    if (!requesterId) {
      return res.status(401).json({ message: 'Unauthorized' })
    }

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    if (project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only the venture owner can update requirements' })
    }

    const nextTeamSize = Number.isFinite(Number(numberOfTeammates))
      ? parseInt(numberOfTeammates, 10)
      : project.numberOfTeammates

    const currentTeamCount = (project.teamMembers || []).length
    if (nextTeamSize < 1 || nextTeamSize > 10) {
      return res.status(400).json({ message: 'Team size must be between 1 and 10' })
    }

    if (nextTeamSize < currentTeamCount) {
      return res.status(400).json({ message: 'Team size cannot be less than current contributors' })
    }

    if (typeof numberOfTeammates !== 'undefined') {
      project.numberOfTeammates = nextTeamSize
    }
    if (typeof visibility === 'string') {
      if (!PROJECT_VISIBILITY.has(visibility)) {
        return res.status(400).json({ message: 'Visibility must be private, college, or global' })
      }
      project.visibility = visibility
    }
    if (typeof lookingForTeammates !== 'undefined') {
      project.lookingForTeammates = lookingForTeammates === true || lookingForTeammates === 'true'
    }
    if (typeof rolesNeeded !== 'undefined') {
      project.rolesNeeded = normalizeLabelList(rolesNeeded)
    }
    if (typeof skillsRequired !== 'undefined') {
      project.skillsRequired = normalizeLabelList(skillsRequired)
    }

    const updatedTeamCount = (project.teamMembers || []).length
    if (updatedTeamCount < (project.numberOfTeammates || 1)) {
      project.momentumStatus = 'needs_team_decision'
      setProjectLifecycle(project, 'planning')
      project.teamCheckIn = {
        status: 'needs_team_decision',
        note: 'Team setup needs attention before increasing scope.',
        updatedAt: new Date(),
        updatedBy: requesterId
      }
    } else if (['building', 'mvp', 'validation'].includes(getProjectLifecycle(project))) {
      project.momentumStatus = 'strong_momentum'
      setProjectLifecycle(project, getProjectLifecycle(project))
      project.teamCheckIn = {
        status: 'strong_momentum',
        note: 'Team capacity reached and build execution is active.',
        updatedAt: new Date(),
        updatedBy: requesterId
      }
    }

    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: requesterId,
      action: 'Updated venture team requirements',
      impact: `Roles: ${(project.rolesNeeded || []).length}, Skills: ${(project.skillsRequired || []).length}, Team size: ${project.numberOfTeammates}.`
    })

    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')

    res.json({ message: 'Venture requirements updated', project: populated })
  } catch (error) {
    console.error('Update venture requirements error:', error)
    res.status(500).json({ message: 'Failed to update venture requirements' })
  }
}

exports.updateProjectDetails = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const { title, shortPitch, description, tags, executionPlan, pipeline } = req.body

    if (!requesterId) {
      return res.status(401).json({ message: 'Unauthorized' })
    }

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    if (project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only the venture owner can update details' })
    }

    if (typeof title === 'string') {
      const normalized = title.trim()
      if (!normalized) {
        return res.status(400).json({ message: 'Title cannot be empty' })
      }
      project.title = normalized
    }

    if (typeof shortPitch === 'string') {
      const normalized = shortPitch.trim()
      if (!normalized) {
        return res.status(400).json({ message: 'Short pitch cannot be empty' })
      }
      project.shortPitch = normalized
    }

    if (typeof description === 'string') {
      const normalized = description.trim()
      project.description = normalized || project.shortPitch || project.title
    }

    if (typeof executionPlan === 'string') {
      const normalized = executionPlan.trim()
      if (!normalized) {
        return res.status(400).json({ message: 'Execution plan cannot be empty' })
      }
      project.executionPlan = normalized
    }

    if (typeof tags !== 'undefined') {
      const normalizedTags = (Array.isArray(tags) ? tags : tags ? [tags] : [])
        .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
        .filter(Boolean)
      project.tags = normalizedTags
    }
    if (typeof pipeline === 'object' && pipeline !== null) {
      project.pipeline = {
        foundation: {
          ...(project.pipeline?.foundation || {}),
          ...(pipeline.foundation || {})
        },
        purpose: {
          ...(project.pipeline?.purpose || {}),
          ...(pipeline.purpose || {})
        },
        readiness: {
          ...(project.pipeline?.readiness || {}),
          ...(pipeline.readiness || {})
        },
        mvp: {
          ...(project.pipeline?.mvp || {}),
          ...(pipeline.mvp || {})
        },
        incubation: {
          ...(project.pipeline?.incubation || {}),
          ...(pipeline.incubation || {})
        }
      }
    }

    const updatedFingerprint = createIdeaFingerprint({
      title: project.title,
      shortPitch: project.shortPitch,
      description: project.description,
      executionPlan: project.executionPlan,
      category: project.category,
      ownerId: project.owner
    })
    project.security = {
      ...(project.security || {}),
      ideaFingerprint: updatedFingerprint,
      fingerprintAlgorithm: 'sha256',
      fingerprintVersion: 1,
      fingerprintedAt: new Date()
    }

    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: requesterId,
      action: 'Updated venture brief',
      impact: 'Refined title/pitch/plan in workspace settings.'
    })

    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')

    res.json({ message: 'Venture details updated', project: populated })
  } catch (error) {
    console.error('Update venture details error:', error)
    res.status(500).json({ message: 'Failed to update venture details' })
  }
}

exports.updateValidationWorkspace = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const {
      problemStatement,
      targetUsers,
      coreAssumptions,
      whoSpokenTo,
      repeatedProblems,
      surprisingInsights,
      useOrPaySignal,
      feedbackChanges,
      validationTasks,
      validationEvidence,
      confidenceScore
    } = req.body

    if (!requesterId) {
      return res.status(401).json({ message: 'Unauthorized' })
    }

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const requesterIdString = requesterId.toString()
    const isOwner = toId(project.owner) === requesterIdString
    const isTeamMember = (project.teamMembers || []).some((memberId) => toId(memberId) === requesterIdString)
    if (!isOwner && !isTeamMember) {
      return res.status(403).json({ message: 'Only startup team members can update validation workspace' })
    }

    if (!project.validation) {
      project.validation = {}
    }
    if (!project.validation.workspace) {
      project.validation.workspace = {}
    }

    if (typeof problemStatement !== 'undefined') {
      project.validation.workspace.problemStatement = normalizeLongText(problemStatement, 3000)
    }

    if (typeof targetUsers !== 'undefined') {
      project.validation.workspace.targetUsers = normalizeLongText(targetUsers, 3000)
    }

    if (typeof coreAssumptions !== 'undefined') {
      project.validation.workspace.coreAssumptions = normalizeValidationAssumptions(coreAssumptions)
    }

    if (typeof whoSpokenTo !== 'undefined') {
      project.validation.workspace.whoSpokenTo = normalizeLongText(whoSpokenTo, 2000)
    }

    if (typeof repeatedProblems !== 'undefined') {
      project.validation.workspace.repeatedProblems = normalizeLongText(repeatedProblems, 2000)
    }

    if (typeof surprisingInsights !== 'undefined') {
      project.validation.workspace.surprisingInsights = normalizeLongText(surprisingInsights, 2000)
    }

    if (typeof useOrPaySignal !== 'undefined') {
      project.validation.workspace.useOrPaySignal = normalizeLongText(useOrPaySignal, 2000)
    }

    if (typeof feedbackChanges !== 'undefined') {
      project.validation.workspace.feedbackChanges = normalizeLongText(feedbackChanges, 2000)
    }

    if (typeof validationTasks !== 'undefined') {
      project.validation.workspace.tasks = normalizeValidationTasks(validationTasks)
    }

    if (typeof validationEvidence !== 'undefined') {
      project.validation.workspace.evidence = normalizeValidationEvidence(validationEvidence)
      project.validation.workspace.lastFeedbackAt = new Date()
    }

    if (typeof confidenceScore !== 'undefined') {
      const numeric = Number(confidenceScore)
      if (Number.isFinite(numeric)) {
        project.validation.workspace.confidenceScore = Math.max(0, Math.min(100, Math.round(numeric)))
      }
    }

    const workspace = project.validation.workspace || {}
    const tasks = workspace.tasks || []
    const evidence = workspace.evidence || []
    const completedTasks = tasks.filter((task) => task.status === 'completed').length
    const taskScore = tasks.length > 0 ? (completedTasks / tasks.length) * 55 : 0
    const evidenceScore = Math.min(25, evidence.length * 5)
    const confidencePart = Math.min(20, Math.max(0, Number(workspace.confidenceScore || 0)) * 0.2)
    const blendedReadiness = toReadinessScore(taskScore + evidenceScore + confidencePart, project.readinessScore)
    project.readinessScore = Math.max(project.readinessScore || 0, blendedReadiness)
    setProjectLifecycle(project, 'validation')
    project.momentumStatus = tasks.length === 0 ? 'facing_blockers' : 'strong_momentum'

    await project.save()

    const pendingTasks = Math.max(0, tasks.length - completedTasks)

    const timeline = [
      ...tasks.map((task) => ({
        type: 'task',
        status: task.status,
        title: task.title,
        at: task.updatedAt || task.completedAt || task.dueDate || project.updatedAt
      })),
      ...evidence.map((item) => ({
        type: 'evidence',
        status: 'logged',
        title: item.title,
        at: item.createdAt || project.updatedAt
      }))
    ]
      .filter((entry) => entry.at)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 50)

    await logContribution({
      projectId: project._id,
      contributor: requesterId,
      action: 'Updated validation workspace',
      impact: `Tasks: ${tasks.length}, Evidence: ${evidence.length}, Confidence: ${workspace.confidenceScore || 0}%`
    })

    return res.json({
      message: 'Validation workspace updated',
      workspace,
      summary: {
        completedTasks,
        pendingTasks,
        totalTasks: tasks.length,
        confidenceScore: workspace.confidenceScore || 0,
        evidenceCount: evidence.length
      },
      timeline
    })
  } catch (error) {
    console.error('Update validation workspace error:', error)
    res.status(500).json({ message: 'Failed to update validation workspace' })
  }
}

exports.removeTeamMember = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId || req.body.requesterId
    const { userId } = req.body

    if (!requesterId || !userId) {
      return res.status(400).json({ message: 'requesterId and userId are required' })
    }

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    if (project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only venture owner can remove team contributors' })
    }

    if (project.owner.toString() === userId.toString()) {
      return res.status(400).json({ message: 'Venture owner cannot be removed' })
    }

    const team = (project.teamMembers || []).map((uid) => uid.toString())
    if (!team.includes(userId.toString())) {
      return res.status(400).json({ message: 'User is not a team contributor' })
    }

    project.teamMembers = project.teamMembers.filter((uid) => uid.toString() !== userId.toString())
    const nextTeamCount = (project.teamMembers || []).length
    if (nextTeamCount < (project.numberOfTeammates || 1)) {
      project.momentumStatus = 'needs_team_decision'
      project.teamCheckIn = {
        status: 'needs_team_decision',
        note: 'Team setup changed; clarify responsibilities before continuing.',
        updatedAt: new Date(),
        updatedBy: requesterId
      }
      if (['building', 'mvp', 'validation'].includes(getProjectLifecycle(project))) {
        setProjectLifecycle(project, 'planning')
      }
    }
    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: requesterId,
      action: 'Removed contributor from startup team',
      impact: `Team size adjusted to ${nextTeamCount}/${project.numberOfTeammates || 1}.`
    })

    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')
      .populate('messages.sender', 'name email')
      .populate('files.uploadedBy', 'name email')
      .populate('validation.sharedFiles.uploadedBy', 'name email')

    res.json({ message: 'Team member removed', project: populated })
  } catch (error) {
    console.error('Error removing team contributor:', error)
    res.status(500).json({ message: 'Failed to remove team contributor' })
  }
}

exports.addProjectMessage = async (req, res) => {
  try {
    const { id } = req.params
    const { text } = req.body
    const userId = req.user.userId

    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Message text is required' })
    }

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const userIdString = userId.toString()
    const team = (project.teamMembers || []).map((uid) => uid.toString())
    const isOwner = project.owner.toString() === userIdString

    if (!isOwner && !team.includes(userIdString)) {
      return res.status(403).json({ message: 'Only team contributors can build update messages' })
    }

    project.messages.push({ sender: userId, text: text.trim() })
    if (!project.buildPhase) project.buildPhase = {}
    project.buildPhase.lastActivity = new Date()
    setProjectLifecycle(project, getProjectLifecycle(project))
    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: userId,
      action: 'Posted build update',
      impact: text.trim().slice(0, 180)
    })

    const messageText = text.trim().toLowerCase()
    if (messageText.includes('@')) {
      const memberIds = [project.owner, ...(project.teamMembers || [])]
        .map((id) => id.toString())
        .filter((id) => id !== userIdString)
      if (memberIds.length > 0) {
        const members = await User.find({ _id: { $in: memberIds } }).select('name')
        const mentioned = members.filter((member) => {
          const name = (member.name || '').trim()
          if (!name) return false
          const parts = name.split(' ').filter(Boolean)
          const patterns = [name, parts[0]].filter(Boolean).map((n) => `@${n.toLowerCase()}`)
          return patterns.some((pattern) => messageText.includes(pattern))
        })

        await Promise.all(
          mentioned.map((member) =>
            createNotification(
              member._id,
              'mention',
              'You were mentioned',
              `You were mentioned in ${project.title}.`,
              project._id,
              userId,
              false,
              `/project/${project._id}`
            )
          )
        )
      }
    }

    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')
      .populate('messages.sender', 'name email')
      .populate('files.uploadedBy', 'name email')
      .populate('validation.sharedFiles.uploadedBy', 'name email')

    res.json({ message: 'Message added', project: populated })
  } catch (error) {
    console.error('Error adding message:', error)
    res.status(500).json({ message: 'Failed to add message' })
  }
}

exports.updateActivity = async (req, res) => {
  try {
    const { id } = req.params
    const userId = req.user.userId

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const isTeamMember = isViewerTeamMember(project, userId.toString()) || toId(project.owner) === userId.toString()
    if (!isTeamMember) {
      return res.status(403).json({ message: 'Only team contributors can update activity' })
    }

    if (!project.buildPhase) project.buildPhase = {}
    project.buildPhase.lastActivity = new Date()
    project.momentumStatus = 'strong_momentum'
    setProjectLifecycle(project, getProjectLifecycle(project))
    project.readinessScore = toReadinessScore((project.readinessScore || 0) + 1, project.readinessScore)
    await project.save()

    res.json({ message: 'Activity updated' })
  } catch (error) {
    console.error('Update activity error:', error)
    res.status(500).json({ message: 'Failed to update activity' })
  }
}

exports.deleteProject = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    if (!requesterId || project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only the venture owner can delete this venture' })
    }

    const ownerId = project.owner.toString()
    const teamIds = (project.teamMembers || []).map((member) => member.toString())
    const uniqueUserIds = Array.from(new Set([ownerId, ...teamIds]))
    const shouldDeductComplete = getProjectLifecycle(project) === 'incubation_ready'

    for (const userId of uniqueUserIds) {
      const user = await User.findById(userId)
      if (!user) continue

      if (userId === ownerId) {
        user.points = (user.points || 0) - POINTS.create_project
        user.projectsCreated = Math.max(0, (user.projectsCreated || 0) - 1)
        if (shouldDeductComplete) {
          user.points -= POINTS.complete_project
          user.projectsCompleted = Math.max(0, (user.projectsCompleted || 0) - 1)
        }
      } else {
        user.points = (user.points || 0) - POINTS.join_project
        user.projectsJoined = Math.max(0, (user.projectsJoined || 0) - 1)
      }

      user.badges = computeBadges(user)
      await user.save()
    }

    await Milestone.deleteMany({ projectId: id })
    await ContributionLog.deleteMany({ projectId: id })
    await Project.deleteOne({ _id: id })

    res.json({ message: 'Venture deleted successfully' })
  } catch (error) {
    console.error('Delete venture error:', error)
    res.status(500).json({ message: 'Failed to delete venture' })
  }
}

exports.addProjectFile = async (req, res) => {
  try {
    const { id } = req.params
    const userId = req.user.userId

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' })
    }

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const userIdString = userId.toString()
    const team = (project.teamMembers || []).map((uid) => uid.toString())
    const isOwner = project.owner.toString() === userIdString

    if (!isOwner && !team.includes(userIdString)) {
      return res.status(403).json({ message: 'Only team contributors can upload files' })
    }

    project.files.push({
      originalName: req.file.originalname,
      filename: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedBy: userId
    })

    project.buildPhase.lastActivity = new Date()
    await project.save()

    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')
      .populate('messages.sender', 'name email')
      .populate('files.uploadedBy', 'name email')
      .populate('validation.sharedFiles.uploadedBy', 'name email')

    res.status(201).json({ message: 'File uploaded', project: populated })
  } catch (error) {
    console.error('Upload file error:', error)
    res.status(500).json({ message: 'Failed to upload file' })
  }
}

exports.deleteProjectFile = async (req, res) => {
  try {
    const { id, fileId } = req.params
    const userId = req.user.userId

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const userIdString = userId.toString()
    const team = (project.teamMembers || []).map((uid) => uid.toString())
    const isOwner = project.owner.toString() === userIdString

    if (!isOwner && !team.includes(userIdString)) {
      return res.status(403).json({ message: 'Only team contributors can remove files' })
    }

    const fileIndex = (project.files || []).findIndex(
      (file) => file._id?.toString() === fileId || file.filename === fileId
    )

    if (fileIndex === -1) {
      return res.status(404).json({ message: 'File not found' })
    }

    const file = project.files[fileIndex]
    const uploaderId = file.uploadedBy?.toString()
    if (!isOwner && uploaderId !== userIdString) {
      return res.status(403).json({ message: 'You can only remove files you uploaded' })
    }

    project.files.splice(fileIndex, 1)

    if (project.validation?.sharedFiles?.length) {
      project.validation.sharedFiles = project.validation.sharedFiles.filter(
        (shared) => shared.filename !== file.filename && shared._id?.toString() !== fileId
      )
    }

    project.buildPhase.lastActivity = new Date()
    await project.save()

    const filePath = path.join(__dirname, '..', 'uploads', file.filename)
    fs.unlink(filePath, () => {})

    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')
      .populate('messages.sender', 'name email')
      .populate('files.uploadedBy', 'name email')
      .populate('validation.sharedFiles.uploadedBy', 'name email')

    res.json({ message: 'File removed', project: populated })
  } catch (error) {
    console.error('Delete file error:', error)
    res.status(500).json({ message: 'Failed to remove file' })
  }
}

exports.downloadProjectFile = async (req, res) => {
  try {
    const { id, fileId } = req.params
    const { exp, sig } = req.query
    const viewerId = req.user?.userId ? req.user.userId.toString() : ''

    if (!viewerId) {
      return res.status(401).json({ message: 'Unauthorized' })
    }

    if (!verifyFileSignature({ projectId: id, fileId, userId: viewerId, expiresAt: exp, sig })) {
      logSecurityEvent('file_access_denied', req, {
        projectId: id,
        fileId,
        reason: 'invalid_signature'
      })
      return res.status(403).json({ message: 'File link expired or invalid. Refresh and try again.' })
    }

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const isOwner = toId(project.owner) === viewerId
    const isTeamMember = isViewerTeamMember(project, viewerId)
    const fileInProject = (project.files || []).find(
      (file) => toId(file._id) === fileId || file.filename === fileId
    )
    const fileInValidation = (project.validation?.sharedFiles || []).find(
      (file) => toId(file._id) === fileId || file.filename === fileId
    )
    const file = fileInProject || fileInValidation

    if (!file) {
      return res.status(404).json({ message: 'File not found' })
    }

    const validationVisible = PUBLIC_VALIDATION_STATES.has(project.validation?.validationStatus)
    const canAccessAsValidator = Boolean(fileInValidation && validationVisible)
    if (!isOwner && !isTeamMember && !canAccessAsValidator) {
      logSecurityEvent('file_access_denied', req, {
        projectId: id,
        fileId,
        reason: 'insufficient_access'
      })
      return res.status(403).json({ message: 'You do not have permission to access this file' })
    }

    const safeFilename = path.basename(file.filename || '')
    if (!safeFilename) {
      return res.status(404).json({ message: 'File not found' })
    }

    const absolutePath = path.join(__dirname, '..', 'uploads', safeFilename)
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ message: 'File missing on server' })
    }

    logSecurityEvent('file_download', req, {
      projectId: id,
      fileId,
      source: fileInProject ? 'project_files' : 'validation_shared_files'
    })

    res.download(absolutePath, file.originalName || safeFilename)
  } catch (error) {
    console.error('Download file error:', error)
    res.status(500).json({ message: 'Failed to download file' })
  }
}

exports.startBuildPhase = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    if (!requesterId || project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only the venture owner can start the build phase' })
    }

    setProjectLifecycle(project, 'building')
    project.momentumStatus = 'strong_momentum'
    project.teamCheckIn = {
      status: 'strong_momentum',
      note: 'Build phase activated.',
      updatedAt: new Date(),
      updatedBy: requesterId
    }
    project.readinessScore = toReadinessScore(project.readinessScore, 30)
    project.buildPhase = {
      startDate: new Date(),
      endDate: undefined,
      isActive: true,
      lastActivity: new Date(),
      lastPenaltyAt: project.buildPhase?.lastPenaltyAt,
      totalDurationDays: 0,
      isExtendedTimeline: false,
      extensionCount: 0,
      extensionDaysGranted: 0
    }

    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: requesterId,
      action: 'Started build phase',
      impact: 'Startup moved into guided building stage.'
    })

    res.json({ message: 'Build phase started', project })
  } catch (error) {
    console.error('Start build phase error:', error)
    res.status(500).json({ message: 'Failed to start build phase' })
  }
}

exports.completeProject = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    if (!requesterId || project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only the venture owner can complete the venture' })
    }

    if (isValidationOutcomePassed(project)) {
      return res.status(400).json({ message: 'Venture is already validated' })
    }

    // Completion is now tied to successful validation.
    res.status(400).json({
      message: 'Ventures are marked complete only after passing validation. Use "Validate Venture" from Team Workspace.'
    })
  } catch (error) {
    console.error('Complete venture error:', error)
    res.status(500).json({ message: 'Failed to complete venture' })
  }
}

exports.startValidation = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const { demoLink, demoNotes, sharedFileIds } = req.body

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    if (!requesterId || project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only the venture owner can validate' })
    }

    if (isLegacyValidationLocked(project) || isValidationOutcomePassed(project)) {
      return res.status(400).json({ message: 'Venture already in validation' })
    }

    if (isValidationOutcomeFailed(project)) {
      return res.status(400).json({
        message: 'This venture needs rework. Use the extend timeline option before sending it to validation again.'
      })
    }

    const lifecycleStage = getProjectLifecycle(project)
    if (!REVIEWABLE_LIFECYCLE_STAGES.has(lifecycleStage)) {
      return res.status(400).json({ message: 'Startup must reach Building, MVP, or Validation before guided validation' })
    }

    setProjectLifecycle(project, 'validation')
    project.momentumStatus = 'strong_momentum'
    project.teamCheckIn = {
      status: 'strong_momentum',
      note: 'Self-conducted validation started with real user feedback collection.',
      updatedAt: new Date(),
      updatedBy: requesterId
    }
    project.buildPhase = {
      ...(project.buildPhase || {}),
      isActive: false,
      lastActivity: new Date()
    }
    if (!project.validation) {
      project.validation = {}
    }
    project.validation.validationStatus = 'pending'
    project.validation.validatedAt = undefined
    project.validation.featuredAt = undefined
    project.validation.lastFailureReason = undefined
    if (typeof demoLink === 'string') {
      project.validation.demoLink = demoLink.trim()
    }
    if (typeof demoNotes === 'string') {
      project.validation.demoNotes = demoNotes.trim()
    }

    const selectedIds = Array.isArray(sharedFileIds)
      ? sharedFileIds
      : sharedFileIds
        ? [sharedFileIds]
        : []
    if (selectedIds.length > 0) {
      const selected = (project.files || []).filter((file) =>
        selectedIds.includes(file._id?.toString()) || selectedIds.includes(file.filename)
      )
      project.validation.sharedFiles = selected
    } else if (Array.isArray(sharedFileIds)) {
      project.validation.sharedFiles = []
    }

    const memberIds = new Set([
      toId(project.owner),
      ...(project.teamMembers || []).map((member) => toId(member))
    ].filter(Boolean))

    const members = memberIds.size
      ? await User.find({ _id: { $in: [...memberIds] } }).select('name email')
      : []

    const certificates = await generateValidationCertificates({ project, members })
    project.validation.certificates = certificates

    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: requesterId,
      action: 'Started self-conducted validation',
      impact: 'Validation questions, evidence, and readiness materials were activated inside the startup workspace.'
    })

    const apiBase = (process.env.PUBLIC_API_BASE || 'https://api.joincollab.org').replace(/\/$/, '')
    const certMap = new Map(certificates.map((cert) => [toId(cert.user), cert]))

    const emailResults = await Promise.allSettled(
      members.map(async (member) => {
        if (!member?.email) return
        const cert = certMap.get(toId(member._id))
        if (!cert) return
        const relativePath = cert.url.startsWith('/') ? cert.url.slice(1) : cert.url
        const filePath = path.join(__dirname, '..', relativePath)
        const verifyUrl = buildVerificationUrl(cert.certificateId)
        const downloadUrl = `${apiBase}${cert.url}`

        const subject = 'Your Collab Startup Execution Certificate'
        const text = `Hi ${member.name || 'there'},\n\nYour startup "${project.title}" has reached the Validation stage inside Collab.\n\nDownload your Startup Execution Certificate: ${downloadUrl}\nVerify: ${verifyUrl}\n\n— Collab`
        const html = `
          <div style="font-family: Arial, sans-serif; line-height:1.6;">
            <p>Hi ${member.name || 'there'},</p>
            <p>Your startup <strong>${project.title}</strong> has reached the <strong>Validation</strong> stage inside Collab.</p>
            <p>You can download your Startup Execution Certificate here:</p>
            <p><a href="${downloadUrl}">${downloadUrl}</a></p>
            <p>Verification link:</p>
            <p><a href="${verifyUrl}">${verifyUrl}</a></p>
            <p style="color:#6b7280;">— Collab</p>
          </div>
        `

        return sendEmail({
          to: member.email,
          subject,
          text,
          html,
          attachments: [{
            filename: cert.filename,
            path: filePath,
            contentType: 'application/pdf'
          }]
        })
      })
    )

    const failedEmails = emailResults.filter((result) => result.status === 'rejected').length

    res.json({
      message: 'Self-conducted validation started',
      project,
      certificateEmails: {
        total: members.length,
        failed: failedEmails
      }
    })
  } catch (error) {
    console.error('Start validation error:', error)
    res.status(500).json({ message: 'Failed to start validation' })
  }
}

exports.removeFromValidation = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    if (!requesterId || project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only the venture owner can update validation status' })
    }

    if (!isLegacyValidationLocked(project)) {
      return res.status(400).json({ message: 'Venture is not in validation' })
    }

    const now = Date.now()
    const existingEndDate = project.buildPhase?.endDate ? new Date(project.buildPhase.endDate).getTime() : 0
    const hasRemainingTime = existingEndDate > now

    setProjectLifecycle(project, 'pivoted')
    project.momentumStatus = 'facing_blockers'
    project.teamCheckIn = {
      status: 'facing_blockers',
      note: 'Returned from validation to address feedback and blockers.',
      updatedAt: new Date(),
      updatedBy: requesterId
    }
    if (!project.buildPhase) {
      project.buildPhase = {}
    }
    project.buildPhase.isActive = true
    project.buildPhase.lastActivity = new Date()
    project.buildPhase.totalDurationDays = project.buildPhase.totalDurationDays || 14
    project.buildPhase.extensionCount = project.buildPhase.extensionCount || 0
    project.buildPhase.extensionDaysGranted = project.buildPhase.extensionDaysGranted || 0
    project.buildPhase.isExtendedTimeline = Boolean(project.buildPhase.extensionDaysGranted > 0)

    if (!hasRemainingTime) {
      const extensionDays = 7
      project.buildPhase.startDate = new Date()
      project.buildPhase.endDate = new Date(Date.now() + extensionDays * 24 * 60 * 60 * 1000)
      project.buildPhase.extensionCount += 1
      project.buildPhase.extensionDaysGranted += extensionDays
      project.buildPhase.totalDurationDays = 14 + project.buildPhase.extensionDaysGranted
      project.buildPhase.isExtendedTimeline = true
    }

    if (!project.validation) {
      project.validation = {}
    }
    project.validation.validationStatus = 'pending'
    project.validation.validatedAt = undefined
    project.validation.featuredAt = undefined
    project.validation.lastFailureReason = undefined

    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: requesterId,
      action: 'Returned venture to build stage',
      impact: 'Validation feedback now being addressed.'
    })

    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')

    res.json({ message: 'Venture removed from validation', project: populated })
  } catch (error) {
    console.error('Remove validation error:', error)
    res.status(500).json({ message: 'Failed to remove venture from validation' })
  }
}

exports.extendValidationTimeline = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const extensionDays = 7

    const project = await Project.findById(id)
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    if (!requesterId || project.owner.toString() !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only the venture owner can extend the timeline' })
    }

    if (!isValidationOutcomeFailed(project) && getProjectLifecycle(project) !== 'pivoted') {
      return res.status(400).json({ message: 'Timeline extension is available only after a failed validation' })
    }

    if (!project.buildPhase) {
      project.buildPhase = {}
    }

    setProjectLifecycle(project, 'building')
    project.momentumStatus = 'facing_blockers'
    project.teamCheckIn = {
      status: 'facing_blockers',
      note: 'Timeline extended for focused rework.',
      updatedAt: new Date(),
      updatedBy: requesterId
    }
    project.buildPhase.startDate = new Date()
    project.buildPhase.endDate = new Date(Date.now() + extensionDays * 24 * 60 * 60 * 1000)
    project.buildPhase.isActive = true
    project.buildPhase.lastActivity = new Date()
    project.buildPhase.extensionCount = (project.buildPhase.extensionCount || 0) + 1
    project.buildPhase.extensionDaysGranted = (project.buildPhase.extensionDaysGranted || 0) + extensionDays
    project.buildPhase.totalDurationDays = 14 + project.buildPhase.extensionDaysGranted
    project.buildPhase.isExtendedTimeline = true

    if (!project.validation) {
      project.validation = {}
    }
    project.validation.validationStatus = 'pending'
    project.validation.validatedAt = undefined
    project.validation.featuredAt = undefined

    await project.save()

    await logContribution({
      projectId: project._id,
      contributor: requesterId,
      action: 'Extended venture timeline',
      impact: `Granted ${extensionDays}-day rework extension.`
    })

    await createNotification(
      project.owner,
      'validation_feedback',
      'Timeline extended for rework',
      `${project.title} has been moved back to the build phase with a 7-day extension.`,
      project._id,
      requesterId,
      false,
      `/project/${project._id}`
    )

    const populated = await Project.findById(project._id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('interestedUsers', 'name email')

    res.json({
      message: 'Venture moved back to dashboard with a 7-day extension',
      project: populated
    })
  } catch (error) {
    console.error('Extend validation timeline error:', error)
    res.status(500).json({ message: 'Failed to extend venture timeline' })
  }
}

exports.getMilestones = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const project = await Project.findById(id).select('owner teamMembers')
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const isTeam = isViewerTeamMember(project, requesterId?.toString()) || toId(project.owner) === requesterId?.toString()
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can access milestones' })
    }

    const milestones = await Milestone.find({ projectId: id })
      .populate('owner', 'name email')
      .populate('createdBy', 'name email')
      .populate('dependencies', 'title status lifecycleStage')
      .sort({ dueDate: 1, createdAt: -1 })

    return res.json({ milestones })
  } catch (error) {
    console.error('Get milestones error:', error)
    return res.status(500).json({ message: 'Failed to fetch milestones' })
  }
}

exports.createMilestone = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const { title, description, owner, lifecycleStage, dueDate, dependencies, blockers, blockerDetails, status, priority } = req.body

    const project = await Project.findById(id).select('owner teamMembers readinessScore lifecycleStage momentumStatus')
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const requesterIdString = requesterId?.toString()
    const isTeam = isViewerTeamMember(project, requesterIdString) || toId(project.owner) === requesterIdString
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can create milestones' })
    }

    const milestone = await Milestone.create({
      projectId: id,
      title: String(title || '').trim(),
      description: typeof description === 'string' ? description.trim() : '',
      owner: owner || undefined,
      lifecycleStage: normalizeLifecycleStage(lifecycleStage || project.lifecycleStage),
      dueDate: dueDate ? new Date(dueDate) : undefined,
      dependencies: normalizeDependencyIds(dependencies),
      blockers: normalizeBlockers(blockers),
      blockerDetails: normalizeBlockerDetails(blockerDetails, requesterId),
      status: ['pending', 'in_progress', 'completed', 'blocked'].includes(status) ? status : 'pending',
      priority: ['low', 'medium', 'high'].includes(priority) ? priority : 'medium',
      createdBy: requesterId
    })

    project.readinessScore = toReadinessScore((project.readinessScore || 0) + 2, project.readinessScore)
    setProjectLifecycle(project, getProjectLifecycle(project))
    project.momentumStatus = milestone.status === 'blocked' ? 'facing_blockers' : project.momentumStatus
    await project.save()

    await logContribution({
      projectId: id,
      contributor: requesterId,
      action: 'Created milestone',
      impact: milestone.title
    })

    const populated = await milestone.populate([
      { path: 'owner', select: 'name email' },
      { path: 'createdBy', select: 'name email' },
      { path: 'dependencies', select: 'title status lifecycleStage' }
    ])
    return res.status(201).json({ message: 'Milestone created', milestone: populated })
  } catch (error) {
    console.error('Create milestone error:', error)
    return res.status(500).json({ message: 'Failed to create milestone' })
  }
}

exports.updateMilestone = async (req, res) => {
  try {
    const { id, milestoneId } = req.params
    const requesterId = req.user?.userId
    const { title, description, owner, lifecycleStage, dueDate, dependencies, blockers, blockerDetails, status, priority } = req.body

    const project = await Project.findById(id).select('owner teamMembers readinessScore momentumStatus lifecycleStage')
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const requesterIdString = requesterId?.toString()
    const isTeam = isViewerTeamMember(project, requesterIdString) || toId(project.owner) === requesterIdString
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can update milestones' })
    }

    const milestone = await Milestone.findOne({ _id: milestoneId, projectId: id })
    if (!milestone) {
      return res.status(404).json({ message: 'Milestone not found' })
    }

    const wasCompleted = milestone.status === 'completed'
    if (typeof title === 'string') milestone.title = title.trim()
    if (typeof description === 'string') milestone.description = description.trim()
    if (typeof owner !== 'undefined') milestone.owner = owner || undefined
    if (typeof lifecycleStage === 'string') milestone.lifecycleStage = normalizeLifecycleStage(lifecycleStage, project.lifecycleStage)
    if (typeof dueDate !== 'undefined') milestone.dueDate = dueDate ? new Date(dueDate) : undefined
    if (typeof dependencies !== 'undefined') milestone.dependencies = normalizeDependencyIds(dependencies)
    if (typeof blockers !== 'undefined') milestone.blockers = normalizeBlockers(blockers)
    if (typeof blockerDetails !== 'undefined') milestone.blockerDetails = normalizeBlockerDetails(blockerDetails, requesterId)
    if (typeof status === 'string' && ['pending', 'in_progress', 'completed', 'blocked'].includes(status)) {
      milestone.status = status
    }
    if (typeof priority === 'string' && ['low', 'medium', 'high'].includes(priority)) {
      milestone.priority = priority
    }
    if (milestone.status === 'completed') {
      milestone.completedAt = milestone.completedAt || new Date()
    } else {
      milestone.completedAt = undefined
    }

    await milestone.save()

    const nowCompleted = milestone.status === 'completed'
    if (nowCompleted && !wasCompleted) {
      project.readinessScore = toReadinessScore((project.readinessScore || 0) + 4, project.readinessScore)
      await User.updateOne(
        { _id: requesterId },
        { $inc: { 'executionProfile.contributionMetrics.milestonesCompleted': 1 } }
      )
    } else if (!nowCompleted && wasCompleted) {
      project.readinessScore = toReadinessScore((project.readinessScore || 0) - 2, project.readinessScore)
    }

    if (milestone.status === 'blocked') {
      project.momentumStatus = 'facing_blockers'
    } else if (project.momentumStatus === 'facing_blockers') {
      project.momentumStatus = 'strong_momentum'
    }
    await project.save()

    await logContribution({
      projectId: id,
      contributor: requesterId,
      action: 'Updated milestone',
      impact: `${milestone.title} (${milestone.status})`
    })

    const populated = await Milestone.findById(milestone._id)
      .populate('owner', 'name email')
      .populate('createdBy', 'name email')
      .populate('dependencies', 'title status lifecycleStage')
    return res.json({ message: 'Milestone updated', milestone: populated })
  } catch (error) {
    console.error('Update milestone error:', error)
    return res.status(500).json({ message: 'Failed to update milestone' })
  }
}

exports.deleteMilestone = async (req, res) => {
  try {
    const { id, milestoneId } = req.params
    const requesterId = req.user?.userId
    const project = await Project.findById(id).select('owner')
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }
    if (!requesterId || toId(project.owner) !== requesterId.toString()) {
      return res.status(403).json({ message: 'Only the venture lead can delete milestones' })
    }

    const deleted = await Milestone.findOneAndDelete({ _id: milestoneId, projectId: id })
    if (!deleted) {
      return res.status(404).json({ message: 'Milestone not found' })
    }

    await logContribution({
      projectId: id,
      contributor: requesterId,
      action: 'Deleted milestone',
      impact: deleted.title
    })

    return res.json({ message: 'Milestone deleted' })
  } catch (error) {
    console.error('Delete milestone error:', error)
    return res.status(500).json({ message: 'Failed to delete milestone' })
  }
}

exports.getContributionLogs = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const project = await Project.findById(id).select('owner teamMembers')
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }
    const isTeam = isViewerTeamMember(project, requesterId?.toString()) || toId(project.owner) === requesterId?.toString()
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can view execution logs' })
    }

    const logs = await ContributionLog.find({ projectId: id })
      .populate('contributor', 'name email')
      .populate('milestoneId', 'title status lifecycleStage')
      .sort({ timestamp: -1 })
      .limit(300)

    return res.json({ logs })
  } catch (error) {
    console.error('Get contribution logs error:', error)
    return res.status(500).json({ message: 'Failed to fetch contribution logs' })
  }
}

exports.createContributionLog = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const { action, impact, milestoneId } = req.body
    const project = await Project.findById(id).select('owner teamMembers readinessScore')
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }
    const isTeam = isViewerTeamMember(project, requesterId?.toString()) || toId(project.owner) === requesterId?.toString()
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can post execution logs' })
    }

    const entry = await logContribution({
      projectId: id,
      contributor: requesterId,
      milestoneId,
      action,
      impact
    })

    project.readinessScore = toReadinessScore((project.readinessScore || 0) + 1, project.readinessScore)
    await project.save()

    return res.status(201).json({ message: 'Execution log added', log: entry })
  } catch (error) {
    console.error('Create contribution log error:', error)
    return res.status(500).json({ message: 'Failed to add execution log' })
  }
}

exports.updateTeamCheckIn = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const { status, note } = req.body
    const project = await Project.findById(id).select('owner teamMembers momentumStatus teamCheckIn readinessScore')
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }
    const isTeam = isViewerTeamMember(project, requesterId?.toString()) || toId(project.owner) === requesterId?.toString()
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can update team check-in' })
    }

    const nextStatus = normalizeMomentumStatus(status)
    project.momentumStatus = nextStatus
    project.teamCheckIn = {
      status: nextStatus,
      note: typeof note === 'string' ? note.trim().slice(0, 500) : '',
      updatedAt: new Date(),
      updatedBy: requesterId
    }

    if (nextStatus === 'strong_momentum') {
      project.readinessScore = toReadinessScore((project.readinessScore || 0) + 1, project.readinessScore)
    } else if (nextStatus === 'facing_blockers' || nextStatus === 'pivoting') {
      project.readinessScore = toReadinessScore((project.readinessScore || 0) - 1, project.readinessScore)
    }

    await project.save()

    await logContribution({
      projectId: id,
      contributor: requesterId,
      action: 'Updated team check-in',
      impact: `${nextStatus}${note ? `: ${String(note).trim().slice(0, 120)}` : ''}`
    })

    return res.json({ message: 'Team check-in updated', momentumStatus: project.momentumStatus, teamCheckIn: project.teamCheckIn })
  } catch (error) {
    console.error('Update team check-in error:', error)
    return res.status(500).json({ message: 'Failed to update team check-in' })
  }
}

exports.getContinuationPlan = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const project = await Project.findById(id)
      .select('owner teamMembers numberOfTeammates lifecycleStage readinessScore momentumStatus teamCheckIn validation buildPhase')
      .lean()
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const requesterIdString = requesterId?.toString()
    const isTeam = isViewerTeamMember(project, requesterIdString) || toId(project.owner) === requesterIdString
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can view continuation plan' })
    }

    const milestones = await Milestone.find({ projectId: id }).lean()
    return res.json(buildContinuationPlan({ project, milestones }))
  } catch (error) {
    console.error('Get continuation plan error:', error)
    return res.status(500).json({ message: 'Failed to load continuation plan' })
  }
}

exports.getIncubationPacket = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const project = await Project.findById(id)
      .populate({ path: 'owner', select: 'name email college course', populate: { path: 'college', select: 'name' } })
      .populate('teamMembers', 'name email')
      .populate('college', 'name')
      .lean()

    if (!project) {
      return res.status(404).json({ message: 'Startup workspace not found' })
    }

    const requesterIdString = requesterId?.toString()
    const isTeam = isViewerTeamMember(project, requesterIdString) || toId(project.owner?._id || project.owner) === requesterIdString
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can view incubation materials' })
    }

    const [milestones, logs] = await Promise.all([
      Milestone.find({ projectId: id }).populate('owner', 'name email').lean(),
      ContributionLog.find({ projectId: id })
        .populate('contributor', 'name email')
        .populate('milestoneId', 'title status lifecycleStage')
        .sort({ timestamp: -1 })
        .limit(100)
        .lean()
    ])

    return res.json({
      packet: buildIncubationPacket({ project, milestones, logs })
    })
  } catch (error) {
    console.error('Get incubation packet error:', error)
    return res.status(500).json({ message: 'Failed to generate incubation packet' })
  }
}

exports.recordProjectAccess = async (req, res) => {
  try {
    const { id } = req.params
    const { accessType, metadata } = req.body
    const requesterId = req.user?.userId
    if (!ACCESS_TYPES.has(accessType)) return res.status(400).json({ message: 'Invalid access type' })

    const project = await Project.findById(id).select('owner teamMembers')
    if (!project) return res.status(404).json({ message: 'Startup workspace not found' })

    const requesterIdString = requesterId?.toString()
    const allowed = req.user?.role === 'admin'
      || toId(project.owner) === requesterIdString
      || isViewerTeamMember(project, requesterIdString)
    if (!allowed) return res.status(403).json({ message: 'Not allowed' })

    await logProjectAccess({ project, userId: requesterId, accessType, metadata })
    res.json({ message: 'Access recorded' })
  } catch (error) {
    console.error('Record project access error:', error)
    res.status(500).json({ message: 'Failed to record access' })
  }
}

exports.getProjectAccessHistory = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId?.toString()
    const project = await Project.findById(id).select('owner')
    if (!project) return res.status(404).json({ message: 'Startup workspace not found' })

    const canView = req.user?.role === 'admin' || toId(project.owner) === requesterId
    if (!canView) return res.status(403).json({ message: 'Only the owner or admin can view access history' })

    const logs = await ProjectAccessLog.find({ project: id })
      .populate('user', 'name email role')
      .sort({ timestamp: -1 })
      .limit(50)
      .lean()
    res.json({ logs })
  } catch (error) {
    console.error('Project access history error:', error)
    res.status(500).json({ message: 'Failed to load access history' })
  }
}

exports.downloadStartupCreationRecord = async (req, res) => {
  try {
    const { id } = req.params
    const project = await Project.findById(id)
      .populate('owner', 'name email')
    if (!project) return res.status(404).json({ message: 'Startup workspace not found' })
    const record = ensureStartupCreationRecord(project)
    if (!project.startupCreationRecord?.verificationHash) {
      project.startupCreationRecord = record
      await project.save()
    }
    const buffer = await createPdfBuffer((doc) => {
      doc.fontSize(20).text('Startup Creation Record')
      doc.moveDown()
      doc.fontSize(11)
      doc.text(`Startup Name: ${record.projectName || project.title}`)
      doc.text(`Founder: ${project.owner?.name || 'Founder'} (${project.owner?.email || 'email unavailable'})`)
      doc.text(`Creation Date: ${new Date(record.createdAt).toLocaleString('en-IN')}`)
      doc.text(`Project ID: ${record.projectId}`)
      doc.moveDown()
      doc.text('Verification Hash:')
      doc.font('Courier').fontSize(9).text(record.verificationHash, { width: 500 })
      doc.font('Helvetica').fontSize(10).moveDown()
      doc.text('This record documents the timestamped creation of this startup workspace inside COLLAB.')
    })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="startup_creation_record.pdf"')
    res.send(buffer)
  } catch (error) {
    console.error('Startup creation record error:', error)
    res.status(500).json({ message: 'Failed to generate creation record' })
  }
}

exports.downloadVentureProvenanceReport = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const project = await Project.findById(id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .lean()
    if (!project) return res.status(404).json({ message: 'Startup workspace not found' })

    const [milestones, logs] = await Promise.all([
      Milestone.find({ projectId: id }).lean(),
      ContributionLog.find({ projectId: id }).lean()
    ])
    const completed = milestones.filter((item) => item.status === 'completed').length
    const validationEntries = project.validation?.workspace?.evidence?.length || 0
    const uploadedEvidence = (project.validation?.sharedFiles || []).length
    await logProjectAccess({ projectId: id, userId: requesterId, accessType: 'package_download', metadata: { artifact: 'venture_provenance_report' } })

    const buffer = await createPdfBuffer((doc) => {
      doc.fontSize(20).text('Venture Provenance Report')
      doc.moveDown()
      doc.fontSize(11)
      doc.text(`Startup Name: ${project.title}`)
      doc.text(`Founder: ${project.owner?.name || 'Founder'}`)
      doc.text(`Team Members: ${(project.teamMembers || []).map((m) => m.name).filter(Boolean).join(', ') || 'Founder only'}`)
      doc.text(`Creation Date: ${new Date(project.createdAt).toLocaleDateString('en-IN')}`)
      doc.text(`Current Startup Stage: ${getLifecycleLabel(project.lifecycleStage)}`)
      doc.text(`Readiness Score: ${project.readinessScore || 0}/100`)
      doc.moveDown()
      doc.text(`Milestones Count: ${milestones.length}`)
      doc.text(`Completed Milestones: ${completed}`)
      doc.text(`Validation Entries: ${validationEntries}`)
      doc.text(`Uploaded Evidence Count: ${uploadedEvidence}`)
      doc.text(`Execution Activity Logs: ${logs.length}`)
    })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="venture_provenance_report.pdf"')
    res.send(buffer)
  } catch (error) {
    console.error('Venture provenance report error:', error)
    res.status(500).json({ message: 'Failed to generate provenance report' })
  }
}

exports.downloadStartupPackage = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const project = await Project.findById(id)
      .populate({ path: 'owner', select: 'name email college course', populate: { path: 'college', select: 'name' } })
      .populate('teamMembers', 'name email')
      .populate('college', 'name')
      .lean()

    if (!project) {
      return res.status(404).json({ message: 'Startup workspace not found' })
    }

    const requesterIdString = requesterId?.toString()
    const isTeam = isViewerTeamMember(project, requesterIdString) || toId(project.owner?._id || project.owner) === requesterIdString
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can download startup package' })
    }

    const [milestones, logs] = await Promise.all([
      Milestone.find({ projectId: id }).populate('owner', 'name email').lean(),
      ContributionLog.find({ projectId: id })
        .populate('contributor', 'name email')
        .populate('milestoneId', 'title status lifecycleStage')
        .sort({ timestamp: -1 })
        .limit(100)
        .lean()
    ])

    const packet = buildIncubationPacket({ project, milestones, logs })
    const zip = await createStartupPackageZip(packet)
    await logProjectAccess({ projectId: id, userId: requesterId, accessType: 'package_download', metadata: { artifact: 'startup_package' } })
    const safeTitle = String(project.title || 'startup').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80)

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_startup_package.zip"`)
    return res.send(zip)
  } catch (error) {
    console.error('Download startup package error:', error)
    return res.status(500).json({ message: 'Failed to generate startup package' })
  }
}

exports.downloadCertificatesZip = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const project = await Project.findById(id)
      .populate('owner', 'name email')
      .populate('teamMembers', 'name email')
      .populate('college', 'name')

    if (!project) {
      return res.status(404).json({ message: 'Startup workspace not found' })
    }

    const requesterIdString = requesterId?.toString()
    const isTeam = isViewerTeamMember(project, requesterIdString) || toId(project.owner?._id || project.owner) === requesterIdString
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can download certificates' })
    }

    const members = [
      project.owner,
      ...(project.teamMembers || []).filter((member) => toId(member?._id || member) !== toId(project.owner?._id || project.owner))
    ].filter(Boolean)
    const milestonesCompleted = await Milestone.countDocuments({ projectId: id, status: 'completed' })
    const certificates = await generateProjectCertificates({ project, members, milestonesCompleted, persist: true })

    const entries = certificates.map((cert) => ({
      name: `certificate_${String(cert.userName || 'team_member').replace(/[^a-z0-9-_]+/gi, '_')}.pdf`,
      data: fs.readFileSync(cert.filePath)
    }))
    const zip = createZipBuffer(entries)
    const safeTitle = String(project.title || 'startup').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80)

    project.validation = project.validation || {}
    project.validation.certificates = [
      ...(project.validation.certificates || []),
      ...certificates.map((cert) => ({
        certificateId: cert.certificateId,
        user: cert.user,
        url: cert.url,
        filename: cert.filename,
        userName: cert.userName,
        role: cert.role,
        startupName: cert.startupName,
        verificationHash: cert.verificationHash,
        verificationUrl: cert.verificationUrl,
        verificationTimestamp: cert.timestamp,
        issuedAt: cert.issuedAt
      }))
    ]
    project.save().catch((saveError) => console.warn('Certificate project history save failed:', saveError.message))

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_certificates.zip"`)
    return res.send(zip)
  } catch (error) {
    console.error('Download certificates error:', error)
    return res.status(500).json({ message: 'Failed to generate certificates' })
  }
}

exports.applyContinuationAction = async (req, res) => {
  try {
    const { id } = req.params
    const requesterId = req.user?.userId
    const { action, note } = req.body
    const project = await Project.findById(id).select('owner teamMembers numberOfTeammates lifecycleStage readinessScore momentumStatus teamCheckIn validation buildPhase')
    if (!project) {
      return res.status(404).json({ message: 'Venture not found' })
    }

    const requesterIdString = requesterId?.toString()
    const isTeam = isViewerTeamMember(project, requesterIdString) || toId(project.owner) === requesterIdString
    if (!isTeam) {
      return res.status(403).json({ message: 'Only startup team members can continue this venture' })
    }

    if (!project.validation) project.validation = {}
    const currentStage = getProjectLifecycle(project)
    const cleanedNote = normalizeLongText(note || '', 800)
    let nextStage = currentStage
    let momentumStatus = normalizeMomentumStatus(project.momentumStatus)
    let readinessDelta = 1
    let activity = 'Continued venture execution'

    if (action === 'continue_planning') {
      nextStage = 'planning'
      momentumStatus = 'strong_momentum'
      readinessDelta = 2
      activity = 'Chose next step: Continue Planning'
    } else if (action === 'continue_building') {
      nextStage = getNextLifecycleStage(currentStage) || currentStage
      if (!['building', 'mvp', 'validation', 'incubation_ready'].includes(nextStage)) nextStage = 'building'
      momentumStatus = 'strong_momentum'
      readinessDelta = 3
      activity = 'Chose next step: Continue Building'
    } else if (action === 'prepare_incubation') {
      nextStage = 'incubation_ready'
      momentumStatus = 'preparing_launch'
      readinessDelta = Math.max(8, 100 - Number(project.readinessScore || 0))
      project.validation.validationStatus = 'passed'
      project.validation.validatedAt = project.validation.validatedAt || new Date()
      project.validation.completionAwarded = true
      activity = 'Chose next step: Prepare For Incubation'
    } else if (action === 'pivot_venture') {
      nextStage = 'pivoted'
      momentumStatus = 'pivoting'
      readinessDelta = -4
      project.validation.validationStatus = project.validation?.validationStatus === 'in_review'
        ? 'pending'
        : project.validation?.validationStatus || 'pending'
      activity = 'Chose next step: Pivot Venture'
    } else if (action === 'relaunch_validation') {
      nextStage = 'validation'
      momentumStatus = 'strong_momentum'
      readinessDelta = 2
      project.validation.validationStatus = 'pending'
      activity = 'Chose next step: Run Self-Conducted Validation'
    } else if (action === 'extend_mvp') {
      nextStage = 'mvp'
      momentumStatus = 'strong_momentum'
      readinessDelta = 4
      project.buildPhase = {
        ...(project.buildPhase || {}),
        isActive: true,
        lastActivity: new Date(),
        totalDurationDays: Math.max(14, Number(project.buildPhase?.totalDurationDays || 14) + 7),
        isExtendedTimeline: true,
        extensionCount: Number(project.buildPhase?.extensionCount || 0) + 1,
        extensionDaysGranted: Number(project.buildPhase?.extensionDaysGranted || 0) + 7
      }
      activity = 'Chose next step: Refine MVP'
    } else if (action === 'archive_venture') {
      nextStage = 'archived'
      momentumStatus = 'pivoting'
      readinessDelta = 0
      activity = 'Chose next step: Archive Venture'
    } else {
      return res.status(400).json({ message: 'Unknown continuation action' })
    }

    if (currentStage !== nextStage && !canTransitionLifecycle(currentStage, nextStage)) {
      const relaxedContinuationTargets = new Set(['planning', 'building', 'validation', 'mvp', 'incubation_ready', 'pivoted', 'archived'])
      if (!relaxedContinuationTargets.has(nextStage)) {
        return res.status(400).json({ message: `Cannot move from ${getLifecycleLabel(currentStage)} to ${getLifecycleLabel(nextStage)}` })
      }
    }

    setProjectLifecycle(project, nextStage)
    project.momentumStatus = momentumStatus
    project.readinessScore = toReadinessScore(Number(project.readinessScore || 0) + readinessDelta, project.readinessScore)
    project.teamCheckIn = {
      status: momentumStatus,
      note: cleanedNote || activity,
      updatedAt: new Date(),
      updatedBy: requesterId
    }

    await project.save()

    await logContribution({
      projectId: id,
      contributor: requesterId,
      action: activity,
      impact: cleanedNote || `Lifecycle now ${getLifecycleLabel(project.lifecycleStage)}`
    })

    const milestones = await Milestone.find({ projectId: id }).lean()
    return res.json({
      message: 'Continuation path applied',
      project: {
        lifecycleStage: project.lifecycleStage,
        readinessScore: project.readinessScore,
        momentumStatus: project.momentumStatus,
        teamCheckIn: project.teamCheckIn
      },
      continuation: buildContinuationPlan({ project: project.toObject(), milestones })
    })
  } catch (error) {
    console.error('Apply continuation action error:', error)
    return res.status(500).json({ message: 'Failed to apply continuation path' })
  }
}
