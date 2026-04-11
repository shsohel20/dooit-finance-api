const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Role = require("../models/Role");
const ErrorResponse = require("../utils/errorResponse");
const asyncHandler = require("./async");
const { generateQR } = require("../utils/qrService");
const { runWithRole } = require("../utils/roleEncryptionPlugin");
const RolePermission = require("../models/RolePermission");

exports.protect = asyncHandler(async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.token) {
    token = req.cookies.token;
  }

  ///Make sure token is exit
  if (!token) {
    return next(new ErrorResponse("Not authorize to access this route", 401));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const u = await User.findById(decoded.id)
      .populate([
        {
          path: "clientBelongs", // virtual on User
          // select: "name _id",
        },
        {
          path: "branchBelongs", // virtual on User
          // select: "name _id",
        },
        {
          path: "client", // virtual on User
          // select: "name _id",
        },
        {
          path: "customer", // virtual on User
          // select: "name _id",
        },
        {
          path: "branch", // virtual on User
          // select: "name _id",
          populate: { path: "client" },
        },
      ])
      .lean();

    const branchData = u.branch ?? u.branchBelongs ?? {}


    const clientId =
      u.client?._id ||
      u.branch?.client?._id ||
      u.clientBelongs?._id ||
      null;
    let qr = null;
    const branchId =
      u.branch?._id ||
      u.branchBelongs?._id ||
      null;
    if (clientId) {
      qr = await generateQR({
        clientId: clientId.toString(),
        branchId: branchId ? branchId.toString() : null,
        format: "base64",

      });
    }




    req.user = {
      ...u,
      id: u._id,
      client: u.client ?? u.branch?.client ?? u?.clientBelongs ?? null,
      branch: {
        ...branchData,
        client: u?.branch?.client?._id,
      },
      qr
    };

    let canReadDecrypted = false;
    let permissions = [];
    try {
      const roleDoc = await Role.findOne({ name: { $regex: new RegExp(`^${u.role}$`, "i") } }).select("_id").lean();
      const roleId = roleDoc?._id;

      ;[canReadDecrypted, permissions] = await Promise.all([
        RolePermission.isGranted(u._id, roleId, { clientId, branchId }),
        RolePermission.getPermissions(roleId),
      ]);
    } catch (permErr) {
      console.error("[auth] RolePermission lookup failed:", permErr.message);
    }
    req.user.permissions = permissions;
    runWithRole(req.user.role, canReadDecrypted, next);
  } catch (error) {
    console.log(error);
    return next(new ErrorResponse("Not authorize to access this route", 401));
  }
});

exports.verifyUser = asyncHandler(async (req, res, next) => {
  try {
    const user = req?.user?.isActive ?? null;
    // console.log(user);
    if (!user) {
      return next(
        new ErrorResponse(
          "Your account not verify yet! Please verify by OTP.",
          401
        )
      );
    }

    next();
  } catch (error) {
    return next(new ErrorResponse("Please verify your account first!", 401));
  }
});

///Grant Access to specific roles
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new ErrorResponse(
          `User role ${req.user.role} is not authorized to access`,
          403
        )
      );
    }
    next();
  };
};

// Grant access only if the user's RolePermission includes ALL of the listed permission strings.
// req.user.permissions is populated by the protect middleware.
exports.authorizePermission = (...perms) => {
  return (req, res, next) => {
    const userPerms = req.user.permissions ?? [];
    const missing = perms.filter((p) => !userPerms.includes(p));
    if (missing.length > 0) {
      return next(
        new ErrorResponse(
          `Missing permission(s): ${missing.join(", ")}`,
          403
        )
      );
    }
    next();
  };
};
