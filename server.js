require("dotenv").config();
const express = require("express");
const sslRedirect = require("express-sslify");
const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 300 }); // Cache expiry time of 5 minutes (300 seconds)
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const fs = require("fs");
const path = require("path");

const mailgun = require("./mailservice");
const consoleRoutes = require("./info"); 
const db = require("./firebase");


const app = express();

// Middleware voor het omleiden van HTTP naar HTTPS in productie
if (process.env.NODE_ENV === "production") {
app.use(sslRedirect.HTTPS({ trustProtoHeader: true })); // Redirect HTTP naar HTTPS
}

// Gebruik de console routes alleen in de ontwikkeling
if (process.env.NODE_ENV === "development") {
  app.use(consoleRoutes);
}


//////////////////////////BESTELLING AFHANDELING//////////////////////////
  
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    // Verifieer de webhook handtekening en verkrijg het evenement
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('⚠️  Webhook fout:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const sessionId = session.id;
  
    try {
      // Haal de line items op
      const lineItems = await stripe.checkout.sessions.listLineItems(sessionId);
  
      // Haal het e-mailadres van de klant op
      let customerEmail = session.customer_email;
      if (!customerEmail && session.customer) {
        const customer = await stripe.customers.retrieve(session.customer);
        customerEmail = customer.email;
      }
  
      // Controleer of de betaling succesvol is
      if (session.payment_status === "paid") {
        const order = {
          name: session.metadata.userName,
          shift: session.metadata.shift,
          mail: customerEmail,
          created_at: new Date().toISOString(),
          items: lineItems.data.map((item) => ({
            name: item.description,
            quantity: item.quantity,
          })),
        };
  
        const totalMenus = lineItems.data.reduce(
          (sum, item) => sum + item.quantity,
          0
        );
        await updateShiftCapacity(session.metadata.shift, totalMenus);
  
        const shift = session.metadata.shift;
        const userName = session.metadata.userName;
  
        // Verstuur de bevestigingsmail via Mailgun
        await mailgun.sendConfirmationEmail(
          customerEmail,
          userName,
          shift,
          order.items
        );
        console.log("Bevestigingsmail succesvol verzonden.");
  
        // Voeg de bestelling toe aan de Firestore-database
        await db.collection("orders").add(order);
        console.log("Document succesvol opgeslagen in Firestore.");
      } else {
        console.log("Betaling niet succesvol");
      }
    } catch (error) {
      console.error("Error processing webhook:", error);
    }
  }
  
  // Bevestig ontvangst van het evenement
  res.json({ received: true });
});

//////////////////////////EINDE BESTELLING AFHANDELING//////////////////////////


app.use(express.json());
app.use(express.static("public"));

// valideer e-mailadres op de server
function validateEmail(email) {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(String(email).toLowerCase());
}

//////////////////////////SHIFT CAPACITEIT//////////////////////////

const SHIFT_LIMIT = 80; // Maximum aantal deelnemers per shift

async function getShiftCount(shift) {
  try {
    // Check of de shift in de cache zit
    const cachedCount = cache.get(shift);
    if (cachedCount !== undefined) {
      console.log(`Cache hit for shift: ${shift}`);
      return cachedCount;
    }

    // Cache miss, fetch van Firestore
    console.log(`Cache miss for shift: ${shift}. Fetching from Firestore.`);
    const shiftDoc = await db.collection("shifts").doc(shift).get();

    let count = 0;
    if (shiftDoc.exists) {
      count = shiftDoc.data().count;
    }
    // opslaan in cache
    cache.set(shift, count);
    console.log(`Shift count for ${shift} is ${count}`);
    return count;

  } catch (error) {
    error.type = "ErrorShiftCount";
    throw error; // Stuur de fout door naar de foutafhandelingsmiddleware

  }
}

// functie voor het ophalen van de huidige capaciteit van een shift
async function updateShiftCapacity(shift, increment) {
    try {
  const shiftRef = db.collection("shifts").doc(shift);

  await db.runTransaction(async (transaction) => {
    const shiftDoc = await transaction.get(shiftRef);

    let currentCount = 0;
    if (!shiftDoc.exists) {
      transaction.set(shiftRef, { count: 0 });
    } else {
      currentCount = shiftDoc.data().count;
    }

    if (currentCount + increment > SHIFT_LIMIT) {
      throw new Error("Shift capacity exceeded");
    }

    const newCount = currentCount + increment;
    transaction.update(shiftRef, { count: newCount });
    console.log(`Shift count updated to ${newCount}`);
    // Update cache with new count
    cache.set(shift, newCount);
  });
}
  catch (error) {
    error.type = "UpdateShiftCount";
    throw error; // Stuur de fout door naar de foutafhandelingsmiddleware
  }
}

app.post('/check-shift-capacity', async (req, res, next) => {
  const { shift } = req.body;
  try {
      // Get the current shift count from Firestore or cache
      const currentShiftCount = await getShiftCount(shift);

      // Return whether the shift is full
      res.json({
          shift: shift,
          isFull: currentShiftCount >= SHIFT_LIMIT,
          currentCount: currentShiftCount,
          maxCapacity: SHIFT_LIMIT
      });
  } catch (error) {
      console.error('Error checking shift capacity:', error);
      error.type = 'FirestoreError';
      next(error);
  }
});
  

//////////////////////////EINDE SHIFT CAPACITEIT//////////////////////////

//////////////////////////STRIPE CHECKOUT//////////////////////////

// Create a Stripe Checkout session
app.post("/create-checkout-session", async (req, res, next) => {
  const { lineItems, shift, email, userName } = req.body;

  if (!lineItems || lineItems.length === 0) {
    return res
      .status(400)
      .json({ error: "Je moet minimaal één menu selecteren." }); /// validateer of er items zijn geselecteerd
  }
  if (!userName) {
    return res.status(400).json({ error: "Gebruikersnaam is verplicht." }); // Valideer of de gebruikersnaam is ingevuld
  }
  if (!email || !validateEmail(email)) {
    return res
      .status(400)
      .json({ error: "Een geldig e-mailadres is verplicht." }); // Valideer of het e-mailadres geldig is
  }

  try {

    //check of de shift vol is
    const currentShiftCount = await getShiftCount(shift);
    const totalMenus = lineItems.reduce((sum, item) => sum + item.quantity, 0);
    if (currentShiftCount + totalMenus > SHIFT_LIMIT) {
      return res.status(400).json({
        error: "Deze shift is vol. Kies een andere shift.",
      });
    }

    // Maak de Stripe Checkout-sessie aan
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card", "ideal", "bancontact"],
      line_items: lineItems.map((item) => ({
        price: item.price,
        quantity: item.quantity,
      })),
      mode: "payment",
      success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`, // Dynamische URL gebruiken
      cancel_url: `${process.env.BASE_URL}/index.html`, // Dynamische URL gebruiken
      customer_email: email,
      metadata: {
        shift: shift,
        userName: userName, // Bewaar de naam als metadata
      },
    });

    // Stuur de sessie-ID terug naar de frontend
    res.json({ id: session.id });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    error.type = "StripeInvalidRequestError"; // Zet het fouttype
    next(error); // Stuur de fout door naar de foutafhandelingsmiddleware
  }
});

// Route voor succesvol afgeronde bestelling
app.get("/success", async (req, res, next) => {
  res.sendFile(path.join(__dirname, "public", "success.html"));
});

//////////////////////////EINDE STRIPE CHECKOUT//////////////////////////

  
//////////////////////////EINDE BESTELLING AFHANDELING//////////////////////////


//////////////////////////FOUTAFHANDELING//////////////////////////

// Universele foutafhandelingsmiddleware
app.use((err, req, res, next) => {
    console.error(err.stack); // Log de volledige fout voor debugging
  
    // Bepaal het fouttype en het bericht
    let errorMessage = "Er is een onbekende fout opgetreden.";
    let errorType = "Onbekende fout"; // Default fouttype
  
    // Dynamische foutafhandeling voor verschillende services
    switch (err.type) {
      case "StripeError":
        errorType = "Betalingsfout";
        errorMessage = "Er is een probleem opgetreden met je betaling. Probeer het later opnieuw.";
        break;
      case "FirestoreError":
        errorType = "Opslagfout";
        errorMessage = "Er was een probleem bij het verwerken van je bestelling. Onze technici zijn op de hoogte.";
        break;
      case "MailgunError":
        errorType = "E-mailfout";
        errorMessage = "We konden de bevestigingsmail niet versturen. Onze excuses voor het ongemak.";
        break;
      default:
        errorType = "Onbekende fout";
        errorMessage = "Er is een onbekende fout opgetreden. Probeer het later opnieuw.";
        break;
    }
  
    // Statische foutpagina met dynamische berichten
    const errorFilePath = path.join(__dirname, "public", "fout.html");
  
    fs.readFile(errorFilePath, "utf8", (fileErr, data) => {
      if (fileErr) {
        console.error("Error reading error file:", fileErr);
        return res.status(500).send("Er is een interne fout opgetreden.");
      }
  
      // Vervang de placeholders in fout.html met dynamische waarden
      let updatedHtml = data.replace("{{message}}", errorMessage);
      updatedHtml = updatedHtml.replace("{{errorType}}", errorType);
  
      // Stuur de geüpdatete HTML-pagina terug naar de gebruiker
      res.status(500).send(updatedHtml);
    });
  });
  

//////////////////////////EINDE FOUTAFHANDELING//////////////////////////


// 

// Start de server, luister op de door Heroku toegewezen poort of 3000 lokaal
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
