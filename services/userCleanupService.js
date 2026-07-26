const mongoose = require('mongoose')
const User = require('../models/User')
const Project = require('../models/Project')
const Milestone = require('../models/Milestone')
const ContributionLog = require('../models/ContributionLog')
const Notification = require('../models/Notification')
const Certificate = require('../models/Certificate')
const JoinRequest = require('../models/JoinRequest')
const Feedback = require('../models/Feedback')
const Task = require('../models/Task')
const FeedPost = require('../models/FeedPost')

const withSession = (session) => (session ? { session } : {})

async function cleanupUser(userId, session) {
  const id = new mongoose.Types.ObjectId(userId)
  const idString = id.toString()
  const opts = withSession(session)

  const ownedProjects = await Project.find({ owner: id }, '_id teamMembers').session(session)
  for (const project of ownedProjects) {
    const nextOwner = (project.teamMembers || []).find((memberId) => memberId.toString() !== idString)
    const update = {
      $pull: { teamMembers: id, interestedUsers: id },
      $unset: { 'teamCheckIn.updatedBy': '' }
    }
    if (nextOwner) update.$set = { owner: nextOwner }
    else update.$unset.owner = ''
    await Project.updateOne({ _id: project._id }, update, opts)
  }

  await Milestone.deleteMany({ $or: [{ owner: id }, { createdBy: id }] }, opts)
  await Milestone.updateMany({ 'blockerDetails.createdBy': id }, { $pull: { blockerDetails: { createdBy: id } } }, opts)
  await ContributionLog.deleteMany({ contributor: id }, opts)
  await Notification.deleteMany({ $or: [{ recipient: id }, { relatedUser: id }] }, opts)
  await Certificate.deleteMany({ user: id }, opts)
  await JoinRequest.deleteMany({ user: id }, opts)
  await Feedback.deleteMany({ user: id }, opts)
  await Task.deleteMany({ assignee: id }, opts)
  await FeedPost.deleteMany({ authorId: idString }, opts)
  await FeedPost.updateMany({}, { $pull: { likedBy: idString, dislikedBy: idString, comments: { authorId: idString } } }, opts)
  await Project.updateMany(
    {
      $or: [
        { teamMembers: id },
        { interestedUsers: id },
        { 'messages.sender': id },
        { 'files.uploadedBy': id },
        { 'validation.sharedFiles.uploadedBy': id },
        { 'validation.certificates.user': id }
      ]
    },
    {
      $pull: {
        teamMembers: id,
        interestedUsers: id,
        messages: { sender: id },
        files: { uploadedBy: id },
        'validation.sharedFiles': { uploadedBy: id },
        'validation.certificates': { user: id }
      }
    },
    opts
  )
  await Project.updateMany({ 'teamCheckIn.updatedBy': id }, { $unset: { 'teamCheckIn.updatedBy': '' } }, opts)
  await User.deleteOne({ _id: id }, opts)
}

async function deleteUserAndAssociatedData(userId) {
  const session = await mongoose.startSession()
  try {
    let usedTransaction = true
    try {
      await session.withTransaction(() => cleanupUser(userId, session))
    } catch (error) {
      usedTransaction = false
      await cleanupUser(userId, null)
    }
    return { deletedUserId: userId.toString(), usedTransaction }
  } finally {
    await session.endSession()
  }
}

module.exports = { deleteUserAndAssociatedData }
