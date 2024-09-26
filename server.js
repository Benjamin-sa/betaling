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
    const { lineItems, shift, userName } = req.body;

    if (!lineItems || lineItems.length === 0) {
        return res.status(400).json({ error: 'Je moet minimaal één menu selecteren.' });
    }

    if (!userName) {
        return res.status(400).json({ error: 'Gebruikersnaam is verplicht.' });
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

// Route voor succesvol afgeronde bestelling
app.get('/success', async (req, res) => {

    const sessionId = req.query.session_id;

    try {
        // Haal de Stripe sessie op om de betaling te controleren
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Als de betaling succesvol is
        if (session.payment_status === 'paid') {
            const order = {
                name: session.metadata.userName,
                shift: session.metadata.shift,
                bbq_menu: session.metadata.bbq_menu || 0,
                vega_menu: session.metadata.vega_menu || 0,
                vis_menu: session.metadata.vis_menu || 0,
                kip_menu: session.metadata.kip_menu || 0,
                created_at: new Date().toISOString()
            };

            const orderDetails = [
                { name: "BBQ Menu", quantity: order.bbq_menu },
                { name: "Vega Menu", quantity: order.vega_menu },
                { name: "Vis Menu", quantity: order.vis_menu },
                { name: "Kip Menu", quantity: order.kip_menu }
            ];
            

            const shift = session.metadata.shift;
            const userName = session.metadata.userName;
            const customerEmail = session.customer_email;

            // Verstuur de bevestigingsmail
            mailgun.sendConfirmationEmail(customerEmail, userName, shift, orderDetails);

            // Sla de bestelling op in het JSON-bestand
            saveOrder(order);

            // Toon de success-pagina
            res.sendFile(path.join(__dirname, 'public', 'success.html'));
        } else {
            res.status(400).send('Betaling niet succesvol');
        }
    } catch (error) {
        console.error('Error retrieving checkout session:', error);
        res.status(500).send('Er is iets misgegaan tijdens het verwerken van de betaling.');
    }
});

// Start de server, luister op de door Heroku toegewezen poort of 3000 lokaal
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
});


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
