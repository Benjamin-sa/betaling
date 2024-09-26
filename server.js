require('dotenv').config();
const express = require('express');
const sslRedirect = require('express-sslify');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_TEST_SECRET_KEY);
const fs = require('fs');
const path = require('path');
const app = express();

const mailgun = require('./mailservice');

app.use(sslRedirect.HTTPS({ trustProtoHeader: true }));

app.use(bodyParser.json());
app.use(express.static('public'));

// Pad naar het JSON-bestand waarin de bestellingen worden opgeslagen
const ordersFile = path.join(__dirname, 'orders.json');

// Maak een Stripe Checkout-sessie aan
app.post('/create-checkout-session', async (req, res) => {
    const { lineItems, shift, email, userName } = req.body;

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
        res.status(500).json({ error: error.message });
    }
});

app.get('/success', async (req, res) => {
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

            // Voor de duidelijkheid: de bestelde items loggen
            console.log('Bestelde items:', JSON.stringify(order.items, null, 2));

            const shift = session.metadata.shift;
            const userName = session.metadata.userName;

            // Fetch customer email if not directly available in session
            let customerEmail = session.customer_email;
            if (!customerEmail && session.customer) {
                const customer = await stripe.customers.retrieve(session.customer);
                customerEmail = customer.email;
            }

            console.log(`Shift: ${shift}, User: ${userName}, Email: ${customerEmail}`);

            // mailgun.sendConfirmationEmail(customerEmail, userName, shift, order.items);
            
            saveOrder(order);

            // Toon de success-pagina
            res.sendFile(path.join(__dirname, 'public', 'success.html'));
        } else {
            res.status(400).send('Betaling niet succesvol');
        }
    } catch (error) {
        console.error('Error retrieving checkout session or line items:', error);
        res.status(500).send('Er is iets misgegaan tijdens het verwerken van de betaling.');
    }
});


// Start de server, luister op de door Heroku toegewezen poort of 3000 lokaal
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
});

// // Functie om te controleren of het e-mailadres geldig is (zelfde regex als in de frontend)
function validateEmail(email) {
    const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return re.test(String(email).toLowerCase());
  }


// Functie om een bestelling op te slaan in het JSON-bestand
function saveOrder(order) {
    fs.readFile(ordersFile, (err, data) => {
        let orders = [];
        if (!err) {
            orders = JSON.parse(data);
        }

        // Voeg de nieuwe bestelling toe aan de array
        orders.push(order);

        // Schrijf de bijgewerkte array terug naar het JSON-bestand
        fs.writeFile(ordersFile, JSON.stringify(orders, null, 2), (err) => {
            if (err) {
                console.error('Error writing to orders file:', err);
            } else {
                console.log('Order saved successfully');
            }
        });
    });
}
