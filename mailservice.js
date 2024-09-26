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

function sendConfirmationEmail(email, userName, shift, orderDetails) {
  const icsFilePath = shift === "shift1"
        ? path.join(__dirname, "ics_files", "shift1.ics")
        : path.join(__dirname, "ics_files", "shift2.ics");

  const icsFile = fs.readFileSync(icsFilePath);

  const data = {
    from: "BBQ LOD LAVKI <noreply@lodlavki.be>",
    to: email,
    subject: "Bevestiging van uw bestelling",
    html: `
      <div style="font-family: Arial, sans-serif; color: #ffffff; background-color: #001F3F; padding: 20px; display: flex; justify-content: center; align-items: center; flex-direction: column; text-align: center;">
        <div style="max-width: 600px; margin: 0 auto;">
          <!-- Groot logo gebruiken -->
          <img src="https://www.lodlavki.be/wp-content/uploads/2024/01/lodlavki-website-2-1536x1005.jpg" alt="BBQ LOD LAVKI" style="width: 400px; margin-bottom: 20px;">
          
          <div style="background-color: #001F3F; padding: 20px; border-radius: 10px;">
            <h2 style="color: #FF4136;">Beste ${userName},</h2>
            <p style="color: #ffffff;">Bedankt voor je bestelling! Hier zijn de details van je bestelling:</p>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
              <thead>
                <tr style="background-color: #FF4136; color: #ffffff;">
                  <th style="padding: 10px; border: 1px solid #ddd;">Menu's</th>
                  <th style="padding: 10px; border: 1px solid #ddd;">Aantal</th>
                </tr>
              </thead>
              <tbody>
                ${orderDetails.map((item) => `
                  <tr>
                    <td style="padding: 10px; border: 1px solid #ddd; color: #ffffff;">${item.name}</td>
                    <td style="padding: 10px; border: 1px solid #ddd; color: #ffffff;">${item.quantity}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
            <p style="color: #ffffff;">Je wordt verwacht in de volgende shift: <strong style="color: #FF4136;">${shift}</strong>.</p>
            <p style="color: #ffffff;">We kijken ernaar uit je te zien!</p>
          </div>
        </div>
        <div style="padding: 20px; text-align: center;">
          <p style="color: #ffffff;">Met vriendelijke groet,<br>BBQ LOD LAVKI Team</p>
          <p style="font-size: 12px; color: #999999;">Dit is een automatische e-mail. Gelieve niet te antwoorden.</p>
        </div>
      </div>
    `,
    attachment: [{
      filename: 'afspraak.ics',
      data: icsFile,
      contentType: 'text/calendar'
    }]
  };

  mg.messages.create(process.env.MAILGUN_DOMAIN, data)
    .then((body) => {
      console.log("Confirmation email sent:", body);
    })
    .catch((error) => {
      console.error("Error sending confirmation email:", error);
    });
}

module.exports = {
  sendConfirmationEmail,
};
