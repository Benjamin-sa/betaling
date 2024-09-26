require('dotenv').config();
const { sendConfirmationEmail } = require('./mailservice.js');

// Dummy order details en user gegevens
const orderDetails = [
    { name: "BBQ Menu", quantity: 2 },
    { name: "Vega Menu", quantity: 1 }
];

// Testgegevens
const email = "benkee.sauter@gmail.com";
const userName = "John Doe";
const shift = "shift1"; // Dit kan 'shift1' of 'shift2' zijn

// Roep de functie aan om een e-mail met ICS-bestand te verzenden
sendConfirmationEmail(email, userName, shift, orderDetails);
