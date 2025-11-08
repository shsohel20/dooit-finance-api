const webPush = require("web-push");
const Notification = require("../models/Notification");
const Client = require("../models/Client");
const User = require("../models/User");
const ErrorResponse = require("./errorResponse");
const Branch = require("../models/Branch");
const crypto = require("crypto");
// ** Checks if an object is empty (returns boolean)
const isObjEmpty = (obj) => {
  return Object?.keys(obj).length === 0;
};

const jsonFormat = (obj) => {
  const object = JSON.parse(JSON.stringify(obj));
  return object;
};
// const knockTheDoor = async (obj) => {
//   const subscriptions = await Notification.find();
//   const { title, details, imageUrl, url } = obj;

//   const payload = JSON.stringify({
//     title,
//     body: details,
//     image: imageUrl, // Additional details
//     url, // Replace with your URL
//   });

//   try {
//     await Promise.all(
//       subscriptions.map((subscription) =>
//         webPush.sendNotification(subscription, payload)
//       )
//     );
//     return {
//       status: 200,
//       message: "Notification sent successfully",
//     };
//   } catch (error) {
//     console.error("Error sending notification:", error);
//     return {
//       status: 500,
//       message: "Failed to send notification",
//     };
//   }
// };

const knockTheDoor = async (obj) => {
  const subscriptions = await Notification.find();
  const { title, details, imageUrl, url } = obj;

  const payload = JSON.stringify({
    title,
    body: details,
    image: imageUrl, // Additional details
    url, // Replace with your URL
  });

  try {
    await Promise.all(
      subscriptions.map((subscription) =>
        webPush.sendNotification(subscription, payload),
      ),
    );
    return {
      status: 200,
      message: "Notification sent successfully",
    };
  } finally {
    // This block will execute regardless of whether there was an error or not
    // console.log("Notification attempt completed");
    return {
      status: 200,
      message: "Notification sent successfully with loop",
    };
  }
};

const validateClientCreation = async (data, next) => {
  const {
    name,
    clientType,
    registrationNumber,
    taxId,
    email,
    phone,
    website,
    userName,
  } = data;

  // Basic required field checks
  if (!name || !email || !userName) {
    return next(
      new ErrorResponse("Name, email, and username are required!", 400),
    );
  }

  // 🟩 Step 1: Validate unique client fields individually
  if (name) {
    const existingByName = await Client.findOne({ name });
    if (existingByName)
      return next(
        new ErrorResponse("Client with this name already exists!", 400),
      );
  }

  if (email) {
    const existingByEmail = await Client.findOne({ email });
    if (existingByEmail)
      return next(
        new ErrorResponse("Client with this email already exists!", 400),
      );
  }

  if (registrationNumber) {
    const existingByReg = await Client.findOne({ registrationNumber });
    if (existingByReg)
      return next(
        new ErrorResponse(
          "Client with this registration number already exists!",
          400,
        ),
      );
  }

  if (taxId) {
    const existingByTax = await Client.findOne({ taxId });
    if (existingByTax)
      return next(
        new ErrorResponse("Client with this tax ID already exists!", 400),
      );
  }

  if (phone) {
    const existingByPhone = await Client.findOne({ phone });
    if (existingByPhone)
      return next(
        new ErrorResponse("Client with this phone number already exists!", 400),
      );
  }

  // if (website) {
  //   const existingByWebsite = await Client.findOne({ website });
  //   console.log(website);
  //   if (existingByWebsite)
  //     return next(
  //       new ErrorResponse("Client with this website already exists!", 400)
  //     );
  // }

  // 🟩 Step 2: Validate unique user fields
  // if (userName) {
  //   const existingUserName = await User.findOne({ userName });
  //   if (existingUserName)
  //     return next(new ErrorResponse("Username is already taken!", 400));
  // }

  // if (email) {
  //   const existingUserEmail = await User.findOne({ email });
  //   if (existingUserEmail)
  //     return next(
  //       new ErrorResponse("Email is already used by another user!", 400),
  //     );
  // }

  return true; // all good
};

/**
 * Validate branch creation data (separate checks for each field)
 * - Ensures required fields
 * - Ensures client exists
 * - Individual uniqueness checks (branchCode per client, email, phone, swiftCode, ifscCode)
 */
const validateBranchCreation = async (req, next) => {
  const {
    name,
    branchCode,
    email,
    phone,
    swiftCode,
    ifscCode,
    slug,
    userName,
    userEmail,
  } = req?.body;
  const loggedInUser = req.user ?? null;
  const client = await Client.findOne({ user: loggedInUser?.id });

  if (!client)
    return next(new ErrorResponse("Client id (client) is required!", 400));
  if (!name) return next(new ErrorResponse("Branch name is required!", 400));
  if (!branchCode)
    return next(new ErrorResponse("branchCode is required!", 400));

  const clientExists = await Client.findById(client);
  if (!clientExists)
    return next(
      new ErrorResponse(`Client not found with id of ${client}`, 404),
    );

  // branchCode unique per client
  if (branchCode) {
    const existingByCode = await Branch.findOne({ client, branchCode });
    if (existingByCode)
      return next(
        new ErrorResponse(
          `A branch with branchCode "${branchCode}" already exists for this client.`,
          409,
        ),
      );
  }

  // existing branch-level checks...
  if (slug) {
    const existingBySlug = await Branch.findOne({ slug });
    if (existingBySlug)
      return next(new ErrorResponse(`Slug "${slug}" is already in use.`, 409));
  }
  if (email) {
    const existingByEmail = await Branch.findOne({
      email: email.toLowerCase(),
    });
    if (existingByEmail)
      return next(
        new ErrorResponse(`Branch email "${email}" is already in use.`, 409),
      );
  }
  if (phone) {
    const existingByPhone = await Branch.findOne({ phone });
    if (existingByPhone)
      return next(
        new ErrorResponse(`Branch phone "${phone}" is already in use.`, 409),
      );
  }
  if (swiftCode) {
    const existingBySwift = await Branch.findOne({ swiftCode });
    if (existingBySwift)
      return next(
        new ErrorResponse(`SWIFT code "${swiftCode}" is already used.`, 409),
      );
  }
  if (ifscCode) {
    const existingByIfsc = await Branch.findOne({ ifscCode });
    if (existingByIfsc)
      return next(
        new ErrorResponse(`IFSC code "${ifscCode}" is already used.`, 409),
      );
  }

  // ---------- USER uniqueness checks for branch-login ---------------
  // if front sends userName / userEmail (or you want auto creation when branch email exists),
  // check User model for duplicates
  // if (userName) {
  //   const existingUserName = await User.findOne({ userName });
  //   if (existingUserName)
  //     return next(
  //       new ErrorResponse(`Username "${userName}" is already taken.`, 409),
  //     );
  // }

  // if (userEmail || email) {
  //   // prefer explicit userEmail, else branch.email
  //   const ue = (userEmail || email).toLowerCase();
  //   const existingUserEmail = await User.findOne({ email: ue });
  //   if (existingUserEmail)
  //     return next(
  //       new ErrorResponse(
  //         `Email "${ue}" is already used by another user.`,
  //         409,
  //       ),
  //     );
  // }

  return true;
};

/**
 * Validate branch update data (similar checks but allow same document)
 * - Accepts branchId (existing branch _id) to exclude from uniqueness queries
 */
const validateBranchUpdate = async (branchId, data, next) => {
  const {
    client,
    branchCode,
    slug,
    email,
    phone,
    swiftCode,
    ifscCode,
    userName,
    userEmail,
  } = data;

  if (client) {
    const clientExists = await Client.findById(client);
    if (!clientExists)
      return next(
        new ErrorResponse(`Client not found with id of ${client}`, 404),
      );
  }

  if (branchCode) {
    const query = client ? { client, branchCode } : { branchCode };
    const existing = await Branch.findOne(query);
    if (existing && existing._id.toString() !== branchId)
      return next(
        new ErrorResponse(
          `Another branch is using branchCode "${branchCode}" for this client.`,
          409,
        ),
      );
  }

  if (slug) {
    const existing = await Branch.findOne({ slug });
    if (existing && existing._id.toString() !== branchId)
      return next(new ErrorResponse(`Slug "${slug}" is already in use.`, 409));
  }

  if (email) {
    const existing = await Branch.findOne({ email: email.toLowerCase() });
    if (existing && existing._id.toString() !== branchId)
      return next(
        new ErrorResponse(`Branch email "${email}" is already in use.`, 409),
      );
  }

  if (phone) {
    const existing = await Branch.findOne({ phone });
    if (existing && existing._id.toString() !== branchId)
      return next(
        new ErrorResponse(`Branch phone "${phone}" is already in use.`, 409),
      );
  }

  if (swiftCode) {
    const existing = await Branch.findOne({ swiftCode });
    if (existing && existing._id.toString() !== branchId)
      return next(
        new ErrorResponse(`SWIFT code "${swiftCode}" is already used.`, 409),
      );
  }

  if (ifscCode) {
    const existing = await Branch.findOne({ ifscCode });
    if (existing && existing._id.toString() !== branchId)
      return next(
        new ErrorResponse(`IFSC code "${ifscCode}" is already used.`, 409),
      );
  }

  // ---------- USER uniqueness for update (exclude current branch's linked user) ----------
  const branch = await Branch.findById(branchId);
  const linkedUserId = branch?.user?.toString();

  if (userName) {
    const existing = await User.findOne({ userName });
    if (existing && existing._id.toString() !== linkedUserId)
      return next(
        new ErrorResponse(`Username "${userName}" is already taken.`, 409),
      );
  }

  if (userEmail || email) {
    const ue = (userEmail || email).toLowerCase();
    const existing = await User.findOne({ email: ue });
    if (existing && existing._id.toString() !== linkedUserId)
      return next(
        new ErrorResponse(
          `Email "${ue}" is already used by another user.`,
          409,
        ),
      );
  }

  return true;
};

function generateRandomPassword(length = 10) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

// generate plain token and hashed version
function createInviteToken() {
  const plain = crypto.randomBytes(20).toString("hex"); // send this
  const hash = crypto.createHash("sha256").update(plain).digest("hex"); // store hashed
  return { plain, hash };
}

// validate provided plain token against stored hash
function hashToken(plain) {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

module.exports = {
  isObjEmpty,
  jsonFormat,
  knockTheDoor,
  validateClientCreation,
  validateBranchCreation,
  validateBranchUpdate,
  generateRandomPassword,
  createInviteToken,
  hashToken,
};
