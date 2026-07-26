const Hackathon = require('../models/Hackathon')
const HackathonRegistration = require('../models/HackathonRegistration')
const HackathonStage = require('../models/HackathonStage')
const JudgingCriteria = require('../models/JudgingCriteria')
const JudgeReview = require('../models/JudgeReview')
const HackathonSubmission = require('../models/HackathonSubmission')
const HackathonAnnouncement = require('../models/HackathonAnnouncement')
const Notification = require('../models/Notification')
const Project = require('../models/Project')
const User = require('../models/User')
const PDFDocument = require('pdfkit')
const { logAdminAction } = require('../services/adminActionLogger')

const adminId = (req) => req.user?._id || req.user?.userId
const projectTeamPopulate = [{ path: 'owner', select: 'name email' }, { path: 'teamMembers', select: 'name email' }]
const toArray = (value) => Array.isArray(value)
  ? value.map((item) => String(item).trim()).filter(Boolean)
  : typeof value === 'string'
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : []
const pickFields = (body = {}) => {
  const allowed = ['title', 'slug', 'description', 'organizer', 'institute', 'country', 'state', 'city', 'eventCategory', 'bannerUrl', 'logoUrl', 'theme', 'location', 'mode', 'startDate', 'endDate', 'rules', 'brochureUrl', 'brochureButtonText', 'brochureVisibility', 'eligibility', 'themes', 'prizes', 'sponsors', 'judges', 'mentors', 'faqs', 'registrationUrl', 'registrationButtonText', 'registrationOpens', 'registrationCloses', 'teamSizeMin', 'teamSizeMax', 'contactEmail', 'activeStage', 'externalEventUrl', 'completionButtonText', 'completionVisibility', 'leaderboardVisibility', 'awards', 'status', 'visibility', 'phase']
  return allowed.reduce((acc, field) => {
    if (body[field] === undefined) return acc
    if (['startDate', 'endDate', 'registrationOpens', 'registrationCloses'].includes(field) && body[field] === '') return acc
    if (field === 'themes' || field === 'prizes' || field === 'sponsors') acc[field] = toArray(body[field])
    else if (field === 'slug') acc[field] = String(body[field]).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    else if (typeof body[field] === 'string') acc[field] = body[field].trim()
    else acc[field] = body[field]
    return acc
  }, {})
}
const sendHackathonError = (res, error, fallback) => {
  const isValidation = error?.name === 'ValidationError' || error?.name === 'CastError'
  res.status(isValidation ? 400 : 500).json({ message: isValidation ? error.message : fallback })
}
const calculateReviewMarks = async (criteriaScores = []) => {
  const ids = criteriaScores.map((item) => item.criteria).filter(Boolean)
  const criteria = await JudgingCriteria.find({ _id: { $in: ids } }).select('maximumMarks').lean()
  const maxById = new Map(criteria.map((item) => [item._id.toString(), Number(item.maximumMarks) || 0]))
  let totalObtainedMarks = 0
  let maximumPossibleMarks = 0
  criteriaScores.forEach((score) => {
    const max = maxById.get(score.criteria?.toString?.() || String(score.criteria)) || 0
    totalObtainedMarks += Math.min(Number(score.obtainedMarks) || 0, max)
    maximumPossibleMarks += max
  })
  return { totalObtainedMarks, maximumPossibleMarks }
}

const buildHackathonResults = async (hackathonId) => {
  const [hackathon, stages, registrations, reviews, criteria] = await Promise.all([
    Hackathon.findById(hackathonId).lean(),
    HackathonStage.find({ hackathon: hackathonId }).sort({ order: 1 }).lean(),
    HackathonRegistration.find({ hackathon: hackathonId })
      .populate({ path: 'project', select: 'title category owner teamMembers', populate: projectTeamPopulate })
      .populate('registeredUsers', 'name email role')
      .lean(),
    JudgeReview.find({ hackathon: hackathonId }).populate('judge', 'name email').populate('criteriaScores.criteria', 'criteriaName maximumMarks').lean(),
    JudgingCriteria.find({}).lean()
  ])
  const criteriaByStage = criteria.reduce((acc, c) => {
    const key = c.stage?.toString()
    if (!acc[key]) acc[key] = []
    acc[key].push(c)
    return acc
  }, {})
  const reviewsByRegistration = reviews.reduce((acc, r) => {
    const key = r.registration?.toString()
    if (!acc[key]) acc[key] = []
    acc[key].push(r)
    return acc
  }, {})
  const rows = registrations.map((registration) => {
    const teamReviews = reviewsByRegistration[registration._id.toString()] || []
    let totalObtainedMarks = 0
    let totalMaximumMarks = 0
    const stageWiseMarks = stages.map((stage) => {
      const stageReviews = teamReviews.filter((r) => r.stage?.toString() === stage._id.toString())
      const criteriaList = criteriaByStage[stage._id.toString()] || []
      const stageMax = criteriaList.reduce((sum, c) => sum + (Number(c.maximumMarks) || 0), 0)
      const obtained = stageReviews.reduce((sum, r) => sum + (Number(r.totalObtainedMarks) || 0), 0)
      const maximum = stageMax * Math.max(1, stageReviews.length)
      totalObtainedMarks += obtained
      totalMaximumMarks += maximum
      return { stageId: stage._id, stageName: stage.stageName, criteria: criteriaList, obtainedMarks: obtained, maximumMarks: maximum, reviews: stageReviews.map((r) => ({ _id: r._id, judge: r.judge, feedback: r.feedback, criteriaScores: r.criteriaScores })) }
    })
    return { registrationId: registration._id, registrationStatus: registration.registrationStatus, project: registration.project, owner: registration.project?.owner, teamMembers: registration.project?.teamMembers || registration.registeredUsers || [], stageWiseMarks, totalObtainedMarks, totalMaximumMarks }
  }).sort((a, b) => b.totalObtainedMarks - a.totalObtainedMarks)
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    row.rank = previous && previous.totalObtainedMarks === row.totalObtainedMarks ? previous.rank : index + 1
    row.percentage = row.totalMaximumMarks ? Math.round((row.totalObtainedMarks / row.totalMaximumMarks) * 10000) / 100 : 0
  })
  return { hackathon, stages, rankings: rows }
}

// Participant views share the exact same ranking calculation as the admin panel.
exports.buildHackathonResults = buildHackathonResults

exports.createHackathon = async (req, res) => {
  try {
    const payload = pickFields(req.body)
    if (!payload.title) return res.status(400).json({ message: 'Hackathon title is required' })
    if (!payload.status) payload.status = 'published'
    if (!payload.visibility) payload.visibility = 'public'
    if (!payload.phase) payload.phase = 'REGISTRATIONS_OPEN'
    const hackathon = await Hackathon.create(payload)
    await logAdminAction({ adminUser: adminId(req), action: 'create_hackathon', targetType: 'hackathon', targetId: hackathon._id })
    res.status(201).json({ hackathon })
  } catch (error) {
    console.error('Create hackathon error:', error)
    sendHackathonError(res, error, 'Failed to create hackathon')
  }
}

exports.listHackathons = async (req, res) => {
  try {
    const hackathons = await Hackathon.find({}).sort({ createdAt: -1 }).limit(200).lean()
    res.json({ hackathons })
  } catch (error) {
    console.error('List hackathons error:', error)
    res.status(500).json({ message: 'Failed to load hackathons' })
  }
}

exports.getHackathonDetails = async (req, res) => {
  try {
    const hackathon = await Hackathon.findById(req.params.id).lean()
    if (!hackathon) return res.status(404).json({ message: 'Hackathon not found' })
    res.json({ hackathon })
  } catch (error) {
    console.error('Hackathon detail error:', error)
    res.status(500).json({ message: 'Failed to load hackathon' })
  }
}

exports.approveHackathon = async (req, res) => {
  try {
    const hackathon = await Hackathon.findByIdAndUpdate(req.params.id, { status: 'published', visibility: 'public', phase: 'REGISTRATIONS_OPEN' }, { new: true, runValidators: true })
    if (!hackathon) return res.status(404).json({ message: 'Hackathon not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'approve_hackathon', targetType: 'hackathon', targetId: hackathon._id })
    res.json({ hackathon })
  } catch (error) {
    console.error('Approve hackathon error:', error)
    sendHackathonError(res, error, 'Failed to approve hackathon')
  }
}

exports.archiveHackathon = async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE_HACKATHON') return res.status(400).json({ message: 'Confirmation required' })
    const hackathon = await Hackathon.findByIdAndUpdate(req.params.id, { status: 'archived', visibility: 'private', archivedAt: new Date(), archivedBy: adminId(req) }, { new: true, runValidators: true })
    if (!hackathon) return res.status(404).json({ message: 'Hackathon not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'archive_hackathon', targetType: 'hackathon', targetId: hackathon._id })
    res.json({ hackathon })
  } catch (error) {
    console.error('Archive hackathon error:', error)
    sendHackathonError(res, error, 'Failed to archive hackathon')
  }
}

exports.restoreHackathon = async (req, res) => {
  try {
    const hackathon = await Hackathon.findByIdAndUpdate(
      req.params.id,
      { status: 'draft', visibility: 'private', phase: 'REGISTRATIONS_CLOSED', archivedAt: undefined, archivedBy: undefined },
      { new: true, runValidators: true }
    )
    if (!hackathon) return res.status(404).json({ message: 'Hackathon not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'restore_hackathon', targetType: 'hackathon', targetId: hackathon._id })
    res.json({ hackathon, message: 'Hackathon restored as a private draft. Publish it when ready.' })
  } catch (error) {
    console.error('Restore hackathon error:', error)
    sendHackathonError(res, error, 'Failed to restore hackathon')
  }
}

exports.permanentlyDeleteHackathon = async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE_HACKATHON') return res.status(400).json({ message: 'Confirmation required' })
    const hackathon = await Hackathon.findById(req.params.id).select('_id title')
    if (!hackathon) return res.status(404).json({ message: 'Hackathon not found' })
    const stages = await HackathonStage.find({ hackathon: hackathon._id }).select('_id')
    await Promise.all([
      HackathonRegistration.deleteMany({ hackathon: hackathon._id }),
      JudgeReview.deleteMany({ hackathon: hackathon._id }),
      HackathonSubmission.deleteMany({ hackathon: hackathon._id }),
      HackathonAnnouncement.deleteMany({ hackathon: hackathon._id }),
      JudgingCriteria.deleteMany({ stage: { $in: stages.map((stage) => stage._id) } }),
      HackathonStage.deleteMany({ hackathon: hackathon._id }),
      Hackathon.findByIdAndDelete(hackathon._id)
    ])
    await logAdminAction({ adminUser: adminId(req), action: 'permanently_delete_hackathon', targetType: 'hackathon', targetId: hackathon._id, details: { title: hackathon.title } })
    res.json({ message: 'Hackathon and its event records were permanently deleted.' })
  } catch (error) {
    console.error('Permanent hackathon deletion error:', error)
    res.status(500).json({ message: 'Failed to permanently delete hackathon' })
  }
}

exports.updateHackathon = async (req, res) => {
  try {
    const hackathon = await Hackathon.findByIdAndUpdate(req.params.id, pickFields(req.body), { new: true, runValidators: true })
    if (!hackathon) return res.status(404).json({ message: 'Hackathon not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'update_hackathon', targetType: 'hackathon', targetId: hackathon._id, details: { fields: Object.keys(req.body || {}) } })
    res.json({ hackathon })
  } catch (error) {
    console.error('Update hackathon error:', error)
    sendHackathonError(res, error, 'Failed to update hackathon')
  }
}

exports.listHackathonRegistrations = async (req, res) => {
  try {
    const registrations = await HackathonRegistration.find({ hackathon: req.params.id })
      .populate({ path: 'project', select: 'title category lifecycleStage owner teamMembers', populate: projectTeamPopulate })
      .populate('registeredUsers', 'name email role')
      .populate('teamLead', 'name email role')
      .populate('currentStage', 'stageName order status')
      .sort({ submittedAt: -1 })
      .lean()
    res.json({ registrations })
  } catch (error) {
    console.error('List hackathon registrations error:', error)
    res.status(500).json({ message: 'Failed to load registrations' })
  }
}

exports.createHackathonRegistration = async (req, res) => {
  try {
    const { projectId } = req.body
    if (!projectId) return res.status(400).json({ message: 'Project is required' })
    const [hackathon, project] = await Promise.all([
      Hackathon.findById(req.params.id),
      Project.findById(projectId).select('owner teamMembers')
    ])
    if (!hackathon) return res.status(404).json({ message: 'Hackathon not found' })
    if (!project) return res.status(404).json({ message: 'Project not found' })
    const registeredUsers = [project.owner, ...(project.teamMembers || [])].filter(Boolean)
    const registration = await HackathonRegistration.findOneAndUpdate(
      { hackathon: hackathon._id, project: project._id },
      { hackathon: hackathon._id, project: project._id, registeredUsers, teamLead: project.owner, registrationStatus: 'pending', submittedAt: new Date() },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    ).populate({ path: 'project', select: 'title category lifecycleStage owner teamMembers', populate: projectTeamPopulate }).populate('registeredUsers', 'name email role').populate('teamLead', 'name email role')
    await logAdminAction({ adminUser: adminId(req), action: 'create_hackathon_registration', targetType: 'hackathon_registration', targetId: registration._id, details: { hackathonId: req.params.id, projectId } })
    res.status(201).json({ registration })
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'Project is already registered' })
    console.error('Create hackathon registration error:', error)
    res.status(500).json({ message: 'Failed to register project' })
  }
}

exports.createHackathonTeam = async (req, res) => {
  try {
    const hackathon = await Hackathon.findById(req.params.id)
    if (!hackathon) return res.status(404).json({ message: 'Hackathon not found' })
    const { projectId, teamName, projectName, leadId, memberIds = [], category = 'Business & Startup', shortPitch = '', description = '', executionPlan = '' } = req.body || {}
    let project
    if (projectId) {
      project = await Project.findById(projectId).select('owner teamMembers')
      if (!project) return res.status(404).json({ message: 'Project not found' })
    } else {
      if (!projectName || !leadId) return res.status(400).json({ message: 'Project name and team lead are required' })
      const lead = await User.findById(leadId).select('_id college')
      if (!lead) return res.status(404).json({ message: 'Team lead not found' })
      const allowedCategories = new Set(['Tech & Product', 'Business & Startup', 'Design & Creative', 'Marketing & Content', 'Services & Operations'])
      const uniqueMembers = [...new Set((Array.isArray(memberIds) ? memberIds : []).map(String).filter((id) => id && id !== String(leadId)))]
      const members = await User.find({ _id: { $in: uniqueMembers } }).select('_id')
      project = await Project.create({
        title: String(projectName).trim(),
        shortPitch: String(shortPitch || projectName).trim().slice(0, 200),
        description: String(description || shortPitch || projectName).trim(),
        category: allowedCategories.has(category) ? category : 'Business & Startup',
        numberOfTeammates: Math.max(1, members.length),
        visibility: 'private',
        executionPlan: String(executionPlan || 'Created by the Builder’s League administration.').trim(),
        owner: lead._id,
        teamMembers: members.map((member) => member._id),
        college: lead.college || undefined
      })
      await User.updateOne({ _id: lead._id }, { $inc: { projectsCreated: 1 } })
    }
    const registeredUsers = [project.owner, ...(project.teamMembers || [])].filter(Boolean)
    const registration = await HackathonRegistration.findOneAndUpdate(
      { hackathon: hackathon._id, project: project._id },
      { hackathon: hackathon._id, project: project._id, teamName: String(teamName || '').trim(), teamLead: project.owner, registeredUsers, registrationStatus: 'approved', submittedAt: new Date() },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    ).populate({ path: 'project', select: 'title category lifecycleStage owner teamMembers', populate: projectTeamPopulate }).populate('registeredUsers', 'name email role').populate('teamLead', 'name email role')
    await logAdminAction({ adminUser: adminId(req), action: 'create_hackathon_team', targetType: 'hackathon_registration', targetId: registration._id, details: { hackathonId: req.params.id, projectId: project._id, teamName: registration.teamName } })
    res.status(201).json({ registration, project })
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'This project is already linked to the hackathon' })
    console.error('Create hackathon team error:', error)
    sendHackathonError(res, error, 'Failed to create hackathon team')
  }
}

exports.updateHackathonTeam = async (req, res) => {
  try {
    const registration = await HackathonRegistration.findOne({ _id: req.params.registrationId, hackathon: req.params.id }).populate('project')
    if (!registration || !registration.project) return res.status(404).json({ message: 'Hackathon team not found' })
    const { teamName, teamLeadId, memberIds, roundStatus, currentStage, adminNotes, registrationStatus } = req.body || {}
    const project = registration.project
    if (teamLeadId !== undefined || memberIds !== undefined) {
      const lead = await User.findById(teamLeadId || registration.teamLead || project.owner).select('_id')
      if (!lead) return res.status(404).json({ message: 'Team lead not found' })
      const ids = [...new Set((Array.isArray(memberIds) ? memberIds : project.teamMembers || []).map(String).filter((id) => id && id !== String(lead._id)))]
      const members = await User.find({ _id: { $in: ids } }).select('_id')
      project.owner = lead._id
      project.teamMembers = members.map((member) => member._id)
      project.numberOfTeammates = Math.max(1, members.length)
      await project.save()
      registration.teamLead = lead._id
      registration.registeredUsers = [lead._id, ...members.map((member) => member._id)]
    }
    if (teamName !== undefined) registration.teamName = String(teamName).trim().slice(0, 180)
    if (roundStatus !== undefined) registration.roundStatus = roundStatus
    if (currentStage !== undefined) registration.currentStage = currentStage || undefined
    if (adminNotes !== undefined) registration.adminNotes = String(adminNotes).trim().slice(0, 3000)
    if (registrationStatus !== undefined) registration.registrationStatus = registrationStatus
    await registration.save()
    await logAdminAction({ adminUser: adminId(req), action: 'update_hackathon_team', targetType: 'hackathon_registration', targetId: registration._id, details: { hackathonId: req.params.id } })
    res.json({ registration })
  } catch (error) {
    console.error('Update hackathon team error:', error)
    sendHackathonError(res, error, 'Failed to update hackathon team')
  }
}

exports.deleteHackathonTeam = async (req, res) => {
  try {
    const registration = await HackathonRegistration.findOneAndDelete({ _id: req.params.registrationId, hackathon: req.params.id })
    if (!registration) return res.status(404).json({ message: 'Hackathon team not found' })
    await Promise.all([
      JudgeReview.deleteMany({ hackathon: req.params.id, registration: registration._id }),
      HackathonSubmission.deleteMany({ hackathon: req.params.id, registration: registration._id })
    ])
    await logAdminAction({ adminUser: adminId(req), action: 'remove_hackathon_team', targetType: 'hackathon_registration', targetId: registration._id, details: { hackathonId: req.params.id, projectId: registration.project } })
    res.json({ message: 'Team removed from this hackathon. Its Collab project was preserved.' })
  } catch (error) {
    console.error('Delete hackathon team error:', error)
    res.status(500).json({ message: 'Failed to remove hackathon team' })
  }
}

exports.getHackathonRegistrationDetails = async (req, res) => {
  try {
    const registration = await HackathonRegistration.findOne({ _id: req.params.registrationId, hackathon: req.params.id })
      .populate({ path: 'project', populate: [{ path: 'owner', select: 'name email' }, { path: 'teamMembers', select: 'name email' }] })
      .populate('registeredUsers', 'name email role')
      .lean()
    if (!registration) return res.status(404).json({ message: 'Registration not found' })
    res.json({ registration })
  } catch (error) {
    console.error('Hackathon registration detail error:', error)
    res.status(500).json({ message: 'Failed to load registration' })
  }
}

exports.updateHackathonRegistrationStatus = async (req, res) => {
  try {
    const allowed = new Set(['pending', 'approved', 'rejected', 'withdrawn'])
    const registrationStatus = req.body.registrationStatus
    if (!allowed.has(registrationStatus)) return res.status(400).json({ message: 'Invalid registration status' })
    const registration = await HackathonRegistration.findOneAndUpdate(
      { _id: req.params.registrationId, hackathon: req.params.id },
      { registrationStatus },
      { new: true, runValidators: true }
    )
    if (!registration) return res.status(404).json({ message: 'Registration not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'update_hackathon_registration_status', targetType: 'hackathon_registration', targetId: registration._id, details: { hackathonId: req.params.id, registrationStatus } })
    res.json({ registration })
  } catch (error) {
    console.error('Update hackathon registration error:', error)
    res.status(500).json({ message: 'Failed to update registration' })
  }
}

exports.createHackathonStage = async (req, res) => {
  try {
    const stage = await HackathonStage.create({ ...req.body, hackathon: req.params.id })
    await logAdminAction({ adminUser: adminId(req), action: 'create_hackathon_stage', targetType: 'hackathon_stage', targetId: stage._id, details: { hackathonId: req.params.id } })
    res.status(201).json({ stage })
  } catch (error) {
    console.error('Create hackathon stage error:', error)
    res.status(500).json({ message: 'Failed to create stage' })
  }
}

exports.listHackathonStages = async (req, res) => {
  try {
    const stages = await HackathonStage.find({ hackathon: req.params.id }).sort({ order: 1, createdAt: 1 }).lean()
    res.json({ stages })
  } catch (error) {
    console.error('List hackathon stages error:', error)
    res.status(500).json({ message: 'Failed to load stages' })
  }
}

exports.updateHackathonStage = async (req, res) => {
  try {
    const stage = await HackathonStage.findOneAndUpdate({ _id: req.params.stageId, hackathon: req.params.id }, req.body, { new: true, runValidators: true })
    if (!stage) return res.status(404).json({ message: 'Stage not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'update_hackathon_stage', targetType: 'hackathon_stage', targetId: stage._id })
    res.json({ stage })
  } catch (error) {
    console.error('Update hackathon stage error:', error)
    res.status(500).json({ message: 'Failed to update stage' })
  }
}

exports.deleteHackathonStage = async (req, res) => {
  try {
    const stage = await HackathonStage.findOneAndDelete({ _id: req.params.stageId, hackathon: req.params.id })
    if (!stage) return res.status(404).json({ message: 'Stage not found' })
    await Promise.all([
      JudgingCriteria.deleteMany({ stage: stage._id }),
      JudgeReview.deleteMany({ hackathon: req.params.id, stage: stage._id })
    ])
    await logAdminAction({ adminUser: adminId(req), action: 'delete_hackathon_stage', targetType: 'hackathon_stage', targetId: stage._id })
    res.json({ message: 'Stage deleted' })
  } catch (error) {
    console.error('Delete hackathon stage error:', error)
    res.status(500).json({ message: 'Failed to delete stage' })
  }
}

exports.createJudgingCriteria = async (req, res) => {
  try {
    const criteria = await JudgingCriteria.create({ ...req.body, stage: req.params.stageId })
    await logAdminAction({ adminUser: adminId(req), action: 'create_judging_criteria', targetType: 'judging_criteria', targetId: criteria._id, details: { stageId: req.params.stageId } })
    res.status(201).json({ criteria })
  } catch (error) {
    console.error('Create judging criteria error:', error)
    res.status(500).json({ message: 'Failed to create criteria' })
  }
}

exports.listJudgingCriteria = async (req, res) => {
  try {
    const criteria = await JudgingCriteria.find({ stage: req.params.stageId }).sort({ createdAt: 1 }).lean()
    res.json({ criteria })
  } catch (error) {
    console.error('List judging criteria error:', error)
    res.status(500).json({ message: 'Failed to load criteria' })
  }
}

exports.updateJudgingCriteria = async (req, res) => {
  try {
    const criteria = await JudgingCriteria.findOneAndUpdate({ _id: req.params.criteriaId, stage: req.params.stageId }, req.body, { new: true, runValidators: true })
    if (!criteria) return res.status(404).json({ message: 'Criteria not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'update_judging_criteria', targetType: 'judging_criteria', targetId: criteria._id })
    res.json({ criteria })
  } catch (error) {
    console.error('Update judging criteria error:', error)
    res.status(500).json({ message: 'Failed to update criteria' })
  }
}

exports.deleteJudgingCriteria = async (req, res) => {
  try {
    const criteria = await JudgingCriteria.findOneAndDelete({ _id: req.params.criteriaId, stage: req.params.stageId })
    if (!criteria) return res.status(404).json({ message: 'Criteria not found' })
    await JudgeReview.updateMany({ 'criteriaScores.criteria': criteria._id }, { $pull: { criteriaScores: { criteria: criteria._id } } })
    await logAdminAction({ adminUser: adminId(req), action: 'delete_judging_criteria', targetType: 'judging_criteria', targetId: criteria._id })
    res.json({ message: 'Criteria deleted' })
  } catch (error) {
    console.error('Delete judging criteria error:', error)
    res.status(500).json({ message: 'Failed to delete criteria' })
  }
}

exports.createJudgeReview = async (req, res) => {
  try {
    const criteriaScores = req.body.criteriaScores || []
    const marks = await calculateReviewMarks(criteriaScores)
    const review = await JudgeReview.findOneAndUpdate(
      { hackathon: req.params.id, stage: req.params.stageId, registration: req.params.registrationId, judge: adminId(req) },
      { hackathon: req.params.id, stage: req.params.stageId, registration: req.params.registrationId, judge: adminId(req), criteriaScores, ...marks, feedback: req.body.feedback || '', submittedAt: new Date() },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    )
    await logAdminAction({ adminUser: adminId(req), action: 'create_judge_review', targetType: 'judge_review', targetId: review._id })
    res.status(201).json({ review })
  } catch (error) {
    console.error('Create judge review error:', error)
    res.status(500).json({ message: 'Failed to create evaluation' })
  }
}

exports.listStageEvaluations = async (req, res) => {
  try {
    const reviews = await JudgeReview.find({ hackathon: req.params.id, stage: req.params.stageId })
      .populate('registration')
      .populate('judge', 'name email')
      .populate('criteriaScores.criteria', 'criteriaName maximumMarks')
      .sort({ submittedAt: -1 })
      .lean()
    res.json({ reviews })
  } catch (error) {
    console.error('List evaluations error:', error)
    res.status(500).json({ message: 'Failed to load evaluations' })
  }
}

exports.getTeamEvaluation = async (req, res) => {
  try {
    const review = await JudgeReview.findOne({ hackathon: req.params.id, stage: req.params.stageId, registration: req.params.registrationId })
      .populate('judge', 'name email')
      .populate('criteriaScores.criteria', 'criteriaName maximumMarks')
      .lean()
    if (!review) return res.status(404).json({ message: 'Evaluation not found' })
    res.json({ review })
  } catch (error) {
    console.error('Get evaluation error:', error)
    res.status(500).json({ message: 'Failed to load evaluation' })
  }
}

exports.updateJudgeReview = async (req, res) => {
  try {
    const criteriaScores = req.body.criteriaScores || []
    const marks = await calculateReviewMarks(criteriaScores)
    const review = await JudgeReview.findOneAndUpdate(
      { _id: req.params.reviewId, hackathon: req.params.id, stage: req.params.stageId },
      { criteriaScores, ...marks, feedback: req.body.feedback || '', submittedAt: new Date() },
      { new: true, runValidators: true }
    )
    if (!review) return res.status(404).json({ message: 'Evaluation not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'update_judge_review', targetType: 'judge_review', targetId: review._id })
    res.json({ review })
  } catch (error) {
    console.error('Update judge review error:', error)
    res.status(500).json({ message: 'Failed to update evaluation' })
  }
}

exports.getHackathonLeaderboard = async (req, res) => {
  try {
    const data = await buildHackathonResults(req.params.id)
    res.json({ leaderboard: data.rankings })
  } catch (error) {
    console.error('Hackathon leaderboard error:', error)
    res.status(500).json({ message: 'Failed to load leaderboard' })
  }
}

exports.getHackathonReport = async (req, res) => {
  try {
    const data = await buildHackathonResults(req.params.id)
    res.json({ hackathon: data.hackathon, teams: data.rankings })
  } catch (error) {
    console.error('Hackathon report error:', error)
    res.status(500).json({ message: 'Failed to load report' })
  }
}

exports.downloadHackathonCsv = async (req, res) => {
  try {
    const data = await buildHackathonResults(req.params.id)
    const lines = ['Rank,Project Name,Team Name,Stage,Total Score']
    data.rankings.forEach((row) => row.stageWiseMarks.forEach((stage) => lines.push([row.rank, row.project?.title || '', (row.teamMembers || []).map((m) => m.name || m.email).join(' / '), stage.stageName, `${row.totalObtainedMarks}/${row.totalMaximumMarks}`].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))))
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename=hackathon_report.csv')
    res.send(lines.join('\n'))
  } catch (error) {
    console.error('Hackathon CSV error:', error)
    res.status(500).json({ message: 'Failed to export CSV' })
  }
}

exports.downloadHackathonPdf = async (req, res) => {
  try {
    const data = await buildHackathonResults(req.params.id)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename=hackathon_report.pdf')
    const doc = new PDFDocument({ margin: 40 })
    doc.pipe(res)
    doc.fontSize(18).text(data.hackathon?.title || 'Hackathon Report')
    data.rankings.forEach((row) => {
      doc.moveDown().fontSize(12).text(`#${row.rank} ${row.project?.title || 'Project'} - ${row.totalObtainedMarks}/${row.totalMaximumMarks}`)
      row.stageWiseMarks.forEach((stage) => {
        doc.fontSize(10).text(`${stage.stageName}: ${stage.obtainedMarks}/${stage.maximumMarks}`)
        stage.reviews.forEach((review) => (review.criteriaScores || []).forEach((score) => doc.text(`- ${score.criteria?.criteriaName || 'Criteria'}: ${score.obtainedMarks}/${score.criteria?.maximumMarks || ''}`)))
      })
    })
    doc.end()
  } catch (error) {
    console.error('Hackathon PDF error:', error)
    res.status(500).json({ message: 'Failed to export PDF' })
  }
}

exports.getHackathonExportData = async (req, res) => {
  try {
    const data = await buildHackathonResults(req.params.id)
    const rows = data.rankings.map((row) => ({
      rank: row.rank,
      projectName: row.project?.title || '',
      teamMembers: (row.teamMembers || []).map((m) => m.name || m.email).join(', '),
      stageScores: row.stageWiseMarks.map((s) => `${s.stageName}: ${s.obtainedMarks}/${s.maximumMarks}`).join(' | '),
      totalScore: `${row.totalObtainedMarks}/${row.totalMaximumMarks}`
    }))
    res.json({ rows })
  } catch (error) {
    console.error('Hackathon export data error:', error)
    res.status(500).json({ message: 'Failed to prepare export data' })
  }
}

exports.submitHackathonProject = async (req, res) => {
  try {
    const registration = await HackathonRegistration.findOne({ _id: req.params.registrationId, hackathon: req.params.id })
    if (!registration) return res.status(404).json({ message: 'Registration not found' })
    const payload = { ...req.body, hackathon: req.params.id, registration: registration._id, project: registration.project, submittedAt: new Date() }
    const submission = await HackathonSubmission.findOneAndUpdate(
      { hackathon: req.params.id, registration: registration._id },
      payload,
      { upsert: true, new: true, runValidators: true }
    )
    await logAdminAction({ adminUser: adminId(req), action: 'submit_hackathon_project', targetType: 'hackathon_submission', targetId: submission._id, details: { hackathonId: req.params.id } })
    res.status(201).json({ submission })
  } catch (error) {
    console.error('Hackathon submission error:', error)
    res.status(500).json({ message: 'Failed to save submission' })
  }
}

exports.listHackathonSubmissions = async (req, res) => {
  try {
    const submissions = await HackathonSubmission.find({ hackathon: req.params.id }).populate({ path: 'project', select: 'title category owner teamMembers', populate: projectTeamPopulate }).populate('registration').sort({ submittedAt: -1 }).lean()
    res.json({ submissions })
  } catch (error) {
    console.error('List hackathon submissions error:', error)
    res.status(500).json({ message: 'Failed to load submissions' })
  }
}

exports.updateHackathonSubmissionStatus = async (req, res) => {
  try {
    const submission = await HackathonSubmission.findOneAndUpdate({ _id: req.params.submissionId, hackathon: req.params.id }, { submissionStatus: req.body.submissionStatus }, { new: true, runValidators: true })
    if (!submission) return res.status(404).json({ message: 'Submission not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'update_hackathon_submission_status', targetType: 'hackathon_submission', targetId: submission._id, details: { status: submission.submissionStatus } })
    res.json({ submission })
  } catch (error) {
    console.error('Update submission status error:', error)
    res.status(500).json({ message: 'Failed to update submission' })
  }
}

exports.createHackathonAnnouncement = async (req, res) => {
  try {
    const announcement = await HackathonAnnouncement.create({ ...req.body, hackathon: req.params.id, createdBy: adminId(req) })
    const [registrations, hackathon] = await Promise.all([
      HackathonRegistration.find({ hackathon: req.params.id, registrationStatus: 'approved' }).select('registeredUsers'),
      Hackathon.findById(req.params.id).select('slug')
    ])
    const recipients = [...new Set(registrations.flatMap((r) => (r.registeredUsers || []).map((u) => u.toString())))]
    if (recipients.length) await Notification.insertMany(recipients.map((recipient) => ({ recipient, type: 'hackathon_announcement', title: announcement.title, message: announcement.message, actionUrl: `/hackathons/${hackathon?.slug || req.params.id}/dashboard` })), { ordered: false })
    await logAdminAction({ adminUser: adminId(req), action: 'create_hackathon_announcement', targetType: 'hackathon_announcement', targetId: announcement._id })
    res.status(201).json({ announcement })
  } catch (error) {
    console.error('Create announcement error:', error)
    res.status(500).json({ message: 'Failed to create announcement' })
  }
}

exports.listHackathonAnnouncements = async (req, res) => {
  try {
    const announcements = await HackathonAnnouncement.find({ hackathon: req.params.id }).populate('createdBy', 'name email').sort({ createdAt: -1 }).lean()
    res.json({ announcements })
  } catch (error) {
    console.error('List announcements error:', error)
    res.status(500).json({ message: 'Failed to load announcements' })
  }
}

exports.updateHackathonAnnouncement = async (req, res) => {
  try {
    const announcement = await HackathonAnnouncement.findOneAndUpdate({ _id: req.params.announcementId, hackathon: req.params.id }, req.body, { new: true, runValidators: true })
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' })
    res.json({ announcement })
  } catch (error) {
    console.error('Update announcement error:', error)
    res.status(500).json({ message: 'Failed to update announcement' })
  }
}

exports.deleteHackathonAnnouncement = async (req, res) => {
  try {
    const announcement = await HackathonAnnouncement.findOneAndDelete({ _id: req.params.announcementId, hackathon: req.params.id })
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' })
    await logAdminAction({ adminUser: adminId(req), action: 'delete_hackathon_announcement', targetType: 'hackathon_announcement', targetId: announcement._id })
    res.json({ message: 'Announcement deleted' })
  } catch (error) {
    console.error('Delete announcement error:', error)
    res.status(500).json({ message: 'Failed to delete announcement' })
  }
}
