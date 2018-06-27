const nodemailer = require("nodemailer");
const currentEnv =
  typeof process.env.APP_ENV !== "undefined" &&
  process.env.APP_ENV !== "development"
    ? process.env.APP_ENV
    : "development";

let transporter;
if (currentEnv !== "development") {
  transporter = nodemailer.createTransport({
    service: "Mailgun",
    auth: {
      user: process.env.MAILGUN_USER,
      pass: process.env.MAILGUN_PASSWORD
    }
  });
} else {
  transporter = nodemailer.createTransport({
    host: "smtp.mailtrap.io",
    port: 2525,
    auth: {
      user: process.env.MAILTRAP_USER,
      pass: process.env.MAILTRAP_PASSWORD
    }
  });
}

module.exports = transporter;
