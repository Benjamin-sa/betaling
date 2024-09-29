require('dotenv').config();
const Mailgun = require("mailgun.js");
const formData = require('form-data');
const fs = require("fs");
const path = require("path");

const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: 'api',
  key: process.env.MAILGUN_SENDING_API_KEY,
  url: 'https://api.eu.mailgun.net'
});

async function sendConfirmationEmail(email, userName, shift, orderDetails) {
  try {
    const icsFilePath = shift === "shift1"
      ? path.join(__dirname, "ics_files", "shift1.ics")
      : path.join(__dirname, "ics_files", "shift2.ics");

    const icsFile = fs.readFileSync(icsFilePath);

  const data = {
    from: "BBQ LOD LAVKI <noreply@lodlavki.be>",
    to: email,
    subject: "Bevestiging van uw bestelling",
    html: `
      <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bestelling Bevestiging</title>
  <style type="text/css">
    body {
      font-family: Arial, sans-serif;
      color: #ffffff;
      background-color: #001F3F;
      margin: 0;
      padding: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    th, td {
      padding: 10px;
      border: 1px solid #ddd;
      color: #ffffff;
    }
    th {
      background-color: #FF4136;
    }
    .email-container {
      max-width: 600px;
      margin: 0 auto;
    }
    .email-header img {
      width: 400px;
      margin-bottom: 20px;
    }
    .email-body {
      background-color: #001F3F;
      padding: 20px;
      border-radius: 10px;
    }
    .email-footer {
      padding: 20px;
      text-align: center;
      width: 100%;
    }
    .email-footer p {
      color: #ffffff;
    }
    .email-footer small {
      font-size: 12px;
      color: #999999;
    }
  </style>
</head>
<body>
  <table cellpadding="0" cellspacing="0" border="0" class="email-container">
    <tr>
      <td class="email-header" align="center">
        <!-- Groot logo gebruiken -->
        <img src="https://www.lodlavki.be/wp-content/uploads/2024/01/lodlavki-website-2-1536x1005.jpg" alt="BBQ LOD LAVKI">
      </td>
    </tr>
    <tr>
      <td class="email-body">
        <h2 style="color: #FF4136;">Beste ${userName},</h2>
        <p>Bedankt voor je bestelling! Hier zijn de details van je bestelling:</p>
        <table cellpadding="0" cellspacing="0" border="0">
          <thead>
            <tr>
              <th>Menu's</th>
              <th>Aantal</th>
            </tr>
          </thead>
          <tbody>
            ${orderDetails.map((item) => `
              <tr>
                <td>${item.name}</td>
                <td>${item.quantity}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <p>Je wordt verwacht in de volgende shift: <b>${shift}</b>.</p>
        <p>We kijken ernaar uit je te zien!</p>
      </td>
    </tr>
    <tr>
      <td class="email-footer">
        <p>Met vriendelijke groet,<br>BBQ LOD LAVKI Team</p>
        <small>Dit is een automatische e-mail. Gelieve niet te antwoorden.</small>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
    attachment: [{
      filename: 'afspraak.ics',
      data: icsFile,
      contentType: 'text/calendar'
    }]
  };

  // Verstuur de e-mail en wacht op het resultaat
  const body = await mg.messages.create(process.env.MAILGUN_DOMAIN, data);
  console.log("Confirmation email sent:", body);

} catch (error) {
  console.error("Error sending confirmation email:", error);
  error.type = "MailgunError"; // Stel het fouttype in
  throw error; // Gooi de fout opnieuw zodat deze kan worden opgevangen door de aanroepende code
}
}

module.exports = {
sendConfirmationEmail,
};