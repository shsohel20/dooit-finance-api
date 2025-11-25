// swagger.js
const swaggerAutogen = require("swagger-autogen")();
const dotenv = require("dotenv");
dotenv.config({ path: "./config/config.env" });

let mainHost = process.env.HOST_SWAGGER;
// if (process.env.HOST_SWAGGER === "development") {
//   mainHost = "localhost:6830";
// } else {
//   mainHost = "20.84.108.147:6830";
// }

const doc = {
  info: {
    title: "Dooit Fintech UI Docs",
    description: "Description",
  },
  host: `${mainHost}/api/v1`,
  schemes: ["http", "https"],
  // GLOBAL Bearer security
  securityDefinitions: {
    BearerAuth: {
      type: "apiKey",
      name: "Authorization",
      in: "header",
      description: "Enter your token as: Bearer <JWT>",
    },
  },
  security: [{ BearerAuth: [] }], // apply globally; remove if some endpoints are public
  definitions: {
    // request bodies
    AuthRegisterBody: {
      name: "Sh Milon",
      userName: "shsohel20",
      userType: "customer",
      email: "shsohel20@gmail.com",
      role: "customer",
      password: "123456",
      isActive: true,
    },
    AuthLoginBody: {
      email: "shsohel20@gmail.com",
      password: "123456",
    },
    ForgotPasswordBody: {
      email: "shsohel20@gmail.com",
      clientUrl: "https://your-client.app", // used in your controller to build reset link
    },
    ResetPasswordBody: {
      password: "newPassword123",
    },
    UpdateMeBody: {
      name: "New Name",
      email: "new@example.com",
      photoUrl: "https://cdn.example.com/photo.jpg",
    },
    UpdatePasswordBody: {
      currentPassword: "123456",
      newPassword: "newPassword123",
    },
    ResendOtpBody: {
      email: "shsohel20@gmail.com",
    },
    ConfirmOtpBody: {
      code: "123456",
    },

    UserCreateBody: {
      name: "John Doe",
      userName: "johndoe",
      email: "john@example.com",
      role: "user",
      phone: "+8801XXXXXXXXX",
      password: "password123",
      isActive: true,
    },
    UserUpdateBody: {
      name: "John Doe",
      userName: "johndoe",
      email: "john@example.com",
      role: "user",
      phone: "+8801XXXXXXXXX",
      photoUrl: "https://cdn.example.com/avatar.jpg",
      isActive: true,
    },
    UserResponse: {
      success: true,
      data: {
        _id: "64f1a8b2a1f2c3d4e5f6a7b8",
        name: "John Doe",
        userName: "johndoe",
        email: "john@example.com",
        role: "user",
        phone: "+8801XXXXXXXXX",
        photoUrl: "https://cdn.example.com/avatar.jpg",
        isActive: true,
        createdAt: "2025-10-01T12:00:00.000Z",
      },
    },

    BranchBody: {
      userName: "gulshanbranch",
      client: "68fe70605a026bb521a8ae28",
      name: "Gulshan Corporate Branch",
      branchCode: "BR002",
      branchType: "Corporate",
      email: "gulshan.branch@company.com",
      phone: "+8801711223344",
      website: "https://company.com/gulshan",
      address: {
        street: "House 24, Road 35, Gulshan-2",
        city: "Dhaka",
        state: "Dhaka Division",
        country: "Bangladesh",
        zipcode: "1212",
      },
      contacts: [
        {
          name: "Rafiul Hasan",
          title: "Branch Manager",
          email: "rafiul.hasan@company.com",
          phone: "+8801711998877",
          primary: true,
        },
      ],
      manager: {
        name: "Rafiul Hasan",
        email: "rafiul.hasan@company.com",
        phone: "+8801711998877",
        employeeId: "EMP-BR002",
      },
      services: ["Corporate Banking", "Loans", "Account Opening"],
      hasATM: true,
      atmDetails: {
        locationDescription: "Inside the branch building, ground floor",
        cashAvailability: true,
      },
      workingHours: {
        monday: {
          open: "09:00",
          close: "17:00",
          closed: false,
        },
        tuesday: {
          open: "09:00",
          close: "17:00",
          closed: false,
        },
        wednesday: {
          open: "09:00",
          close: "17:00",
          closed: false,
        },
        thursday: {
          open: "09:00",
          close: "17:00",
          closed: false,
        },
        friday: {
          open: "09:00",
          close: "13:00",
          closed: false,
        },
        saturday: {
          closed: true,
        },
        sunday: {
          closed: true,
        },
      },
      documents: [
        {
          name: "Trade License",
          url: "https://cdn.company.com/docs/gulshan-trade-license.pdf",
          mimeType: "application/pdf",
          type: "license",
        },
      ],
      status: "Active",
      settings: {
        currency: "BDT",
        timezone: "Asia/Dhaka",
      },
      metadata: {},
    },

    EcddReport: {
      analystName: "John Smith",
      position: "Analyst",
      date: "2025-11-22",
      caseNumber: "CASE-001",
      userId: "64f1a8b2a1f2c3d4e5f6a7b8",
      fullName: "Jane Doe",
      customerName: "Acme Corp",
      totalDepositsAUD: 10000,
      isPEP: "No",
      recommendation: "Approved",
    },
    // response shapes (examples)
    AuthSuccessResponse: {
      success: true,
      message: "Login successful",
      token: "Bearer <JWT>",
    },
    GenericSuccess: {
      success: true,
      data: {},
    },
    ErrorResponse: {
      success: false,
      message: "Error message here",
    },
  },
};

const outputFile = "./swagger-output.json";
// point to the file(s) where routes live; you can pass multiple files
const endpointsFiles = [
  "./routes/index.js",
  // add this (or "./routes/ecdd.js" if you kept that name)
];

swaggerAutogen(outputFile, endpointsFiles, doc).then(() => {
  console.log("Swagger output generated to", outputFile);
  // Optionally start your server automatically here:
  // require("./server.js");
});
