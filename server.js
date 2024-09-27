require('dotenv').config();
const express = require('express');
const sslRedirect = require('express-sslify');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_TEST_SECRET_KEY);
const fs = require('fs');
const path = require('path');
const app = express();

const mailgun = require('./mailservice');
const admin = require('firebase-admin');

// Firebase Admin configuratie
admin.initializeApp({
  credential: admin.credential.cert({
    "type": "service_account",
    "project_id": process.env.FIREBASE_PROJECT_ID,
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Vervang \n door echte nieuwe regels
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": process.env.FIREBASE_AUTH_URI,
    "token_uri": process.env.FIREBASE_TOKEN_URI,
    "auth_provider_x509_cert_url": process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_CERT_URL
  }),
  databaseURL: "https://bbqlodlavki.firebaseio.com"
});

const db = admin.firestore();

// Middleware om alle verzoeken om te leiden naar HTTPS
app.use(sslRedirect.HTTPS({ trustProtoHeader: true }));

// Gebruik bodyParser om JSON-verzoeken te verwerken
app.use(bodyParser.json());
app.use(express.static('public'));

// Pad naar het JSON-bestand waarin de bestellingen worden opgeslagen (wordt nu niet meer gebruikt omdat we Firestore gebruiken)
const ordersFile = path.join(__dirname, 'orders.json');

// Functie om e-mailadres te valideren
function validateEmail(email) {
    const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return re.test(String(email).toLowerCase());
}

// Maak een Stripe Checkout-sessie aan
app.post('/create-checkout-session', async (req, res, next) => {
    const { lineItems, shift, email, userName } = req.body;

    // Valideer de verzoekgegevens
    if (!lineItems || lineItems.length === 0) {
        return res.status(400).json({ error: 'Je moet minimaal één menu selecteren.' });
    }

    if (!userName) {
        return res.status(400).json({ error: 'Gebruikersnaam is verplicht.' });
    }

    if (!email || !validateEmail(email)) {
        return res.status(400).json({ error: 'Een geldig e-mailadres is verplicht.' });
    }

    try {
        // Maak de Stripe Checkout-sessie aan
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card', 'ideal', 'bancontact'],
            line_items: lineItems.map(item => ({
                price: item.price,
                quantity: item.quantity,
            })),
            mode: 'payment',
            success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`, // Dynamische URL gebruiken
            cancel_url: `${process.env.BASE_URL}/index.html`, // Dynamische URL gebruiken
            customer_email: email,
            metadata: {
                shift: shift,
                userName: userName,  // Bewaar de naam als metadata
            },
        });

        // Stuur de sessie-ID terug naar de frontend
        res.json({ id: session.id });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        error.type = 'StripeInvalidRequestError'; // Zet het fouttype
        next(error); // Stuur de fout door naar de foutafhandelingsmiddleware
    }
});

// Route voor succesvol afgeronde bestelling
app.get('/success', async (req, res, next) => {
    const sessionId = req.query.session_id;

    try {
        // Haal de Stripe sessie op
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Haal de werkelijke bestelde items op via de line_items van Stripe
        const lineItems = await stripe.checkout.sessions.listLineItems(sessionId);

        // Als de betaling succesvol is
        if (session.payment_status === 'paid') {
            const order = {
                name: session.metadata.userName,
                shift: session.metadata.shift,
                created_at: new Date().toISOString(),
                items: lineItems.data.map(item => ({
                    name: item.description,
                    quantity: item.quantity
                }))
            };

            console.log('Bestelde items:', JSON.stringify(order.items, null, 2));

            const shift = session.metadata.shift;
            const userName = session.metadata.userName;

            // Haal het e-mailadres van de klant op, indien niet beschikbaar in sessie
            let customerEmail = session.customer_email;
            if (!customerEmail && session.customer) {
                const customer = await stripe.customers.retrieve(session.customer);
                customerEmail = customer.email;
            }

            console.log(`Shift: ${shift}, User: ${userName}, Email: ${customerEmail}`);

            // Verstuur de bevestigingsmail via Mailgun
            try {
                await mailgun.sendConfirmationEmail(customerEmail, userName, shift, order.items);
                console.log('Bevestigingsmail succesvol verzonden.');
            } catch (mailError) {
                console.error('Error bij het versturen van bevestigingsmail:', mailError);
                mailError.type = 'MailgunError'; // Zet het fouttype
                next(mailError); // Stuur door naar de foutafhandelingsmiddleware
            }

            // Voeg de bestelling toe aan de Firestore-database
            try {
                await db.collection('orders').add(order);
                console.log("Document succesvol opgeslagen in Firestore.");
            } catch (firestoreError) {
                console.error('Error bij het opslaan van de bestelling in Firestore:', firestoreError);
                firestoreError.type = 'FirestoreError'; // Zet het fouttype
                next(firestoreError); // Stuur door naar de foutafhandelingsmiddleware
            }

            // Toon de success-pagina
            res.sendFile(path.join(__dirname, 'public', 'success.html'));
        } else {
            res.status(400).send('Betaling niet succesvol');
        }
    } catch (error) {
        console.error('Error retrieving checkout session or line items:', error);
        error.type = 'StripeError'; // Zet het fouttype
        next(error); // Stuur de fout door naar de foutafhandelingsmiddleware
    }
});

// Universele foutafhandelingsmiddleware
app.use((err, req, res, next) => {
    console.error(err.stack); // Log de volledige fout voor debugging

    // Bepaal het fouttype en het bericht
    let errorMessage = "Er is een onbekende fout opgetreden.";
    let errorType = "Onbekende fout"; // Default fouttype

    // Dynamische foutafhandeling voor verschillende services
    if (err.type === 'StripeInvalidRequestError') {
        errorType = "Betalingsfout";
        errorMessage = "Er is een probleem opgetreden met je betaling. Probeer het later opnieuw.";
    } else if (err.type === 'FirestoreError') {
        errorType = "Opslagfout";
        errorMessage = "Er was een probleem bij het opslaan van je bestelling. Onze technici zijn op de hoogte.";
    } else if (err.type === 'MailgunError') {
        errorType = "E-mailfout";
        errorMessage = "We konden de bevestigingsmail niet versturen. Onze excuses voor het ongemak.";
    }

    // Statische foutpagina met dynamische berichten
    const errorFilePath = path.join(__dirname, 'public', 'fout.html');

    fs.readFile(errorFilePath, 'utf8', (fileErr, data) => {
        if (fileErr) {
            console.error('Error reading error file:', fileErr);
            return res.status(500).send('Er is een interne fout opgetreden.');
        }

        // Vervang de placeholders in fout.html met dynamische waarden
        let updatedHtml = data.replace('{{message}}', errorMessage);
        updatedHtml = updatedHtml.replace('{{errorType}}', errorType);

        // Stuur de geüpdatete HTML-pagina terug naar de gebruiker
        res.status(500).send(updatedHtml);
    });
});

// Start de server, luister op de door Heroku toegewezen poort of 3000 lokaal
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
});
