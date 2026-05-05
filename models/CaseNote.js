const mongoose = require('mongoose');
const { Schema } = mongoose;

const CaseNoteSchema = new mongoose.Schema(
  {
    client: {
      type: Schema.Types.ObjectId,
      ref: 'Client',
      index: true,
      default: null,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      index: true,
      default: null,
    },
    case: {
      type: Schema.Types.ObjectId,
      ref: 'Case',
      required: [true, 'Case reference is required'],
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: 'Users',
      required: [true, 'Author is required'],
    },
    content: {
      type: String,
      required: [true, 'Note content is required'],
      trim: true,
      maxlength: [10000, 'Note cannot exceed 10000 characters'],
    },
    attachments: [
      {
        type: String,
        trim: true,
      },
    ],
  },
  { timestamps: true }
);

CaseNoteSchema.index({ case: 1, createdAt: -1 });
CaseNoteSchema.index({ client: 1, branch: 1 });

module.exports = mongoose.model('CaseNote', CaseNoteSchema);
