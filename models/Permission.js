const mongoose = require('mongoose');
const { default: slugify } = require('slugify');

const PermissionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add permission'],
      trim: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    }
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true
  }
);



module.exports = mongoose.model('Permissions', PermissionSchema);
