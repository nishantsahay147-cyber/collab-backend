const mongoose = require('mongoose')

const HackathonStageSchema = new mongoose.Schema({
  hackathon: { type: mongoose.Schema.Types.ObjectId, ref: 'Hackathon', required: true, index: true },
  stageName: { type: String, required: true, trim: true, maxlength: 160 },
  description: { type: String, default: '', trim: true, maxlength: 3000 },
  deadline: { type: Date },
  instructions: { type: String, default: '', trim: true, maxlength: 5000 },
  submissionRequired: { type: Boolean, default: false },
  visibility: { type: String, enum: ['participants', 'admin'], default: 'participants' },
  order: { type: Number, default: 0, index: true },
  maximumMarks: { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    enum: ['draft', 'active', 'completed', 'archived'],
    default: 'draft',
    index: true
  }
}, { timestamps: true })

HackathonStageSchema.index({ hackathon: 1, order: 1 })

module.exports = mongoose.model('HackathonStage', HackathonStageSchema)
