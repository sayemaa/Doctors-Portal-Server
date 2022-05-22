const express = require('express');
const cors = require('cors');
const app = express();
const jwt = require('jsonwebtoken');
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

const nodemailer = require('nodemailer');
const mg = require('nodemailer-mailgun-transport');

// middleware
app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.cs8y2.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

/*--------------
    verifyJWT
----------------*/
function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: 'Unauthorized access' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'Forbidden access' })
        }
        req.decoded = decoded;
        next();
    });
}

const auth = {
    auth: {
        api_key: process.env.EMAIL_SENDER_KEY,
        domain: 'sandbox9dfc742a95b94f75abf1ab3e6c83f880.mailgun.org'
    },
};

const nodemailerMailgun = nodemailer.createTransport(mg(auth));

function sendAppointmentEmail(booking) {
    const { patient, patientName, treatment, date, slot } = booking;

    var email = {
        from: process.env.EMAIL_SENDER,
        to: patient,
        subject: `Your Appointment for ${treatment} is on ${date} at ${slot} is Confirmed`,
        text: `Your Appointment for ${treatment} is on ${date} at ${slot} is Confirmed`,
        html: `
        <div>
                <p>Hello ${patientName}, </p>
                <h3>Your Appointment for ${treatment} is confirmed</h3>
                <p>Looking forward to seeing you on ${date} at ${slot}.</p>

                <h3>Our Address</h3>
                <p>Andor Killa Bandorban</p>
                <p>Bangladesh</p>
                <a href="https://web.programming-hero.com/">Unsubscribe</a>
            </div>
        `,
    };

    nodemailerMailgun.sendMail(email, (err, info) => {
        if (err) {
            console.log(err);
        }
        else {
            console.log('Message sent: ', info);
        }
    });
}


async function run() {
    try {
        await client.connect();
        const serviceCollection = client.db('doctors_portal').collection('services');
        const bookingCollection = client.db('doctors_portal').collection('bookings');
        const userCollection = client.db('doctors_portal').collection('users');
        const doctorCollection = client.db('doctors_portal').collection('doctors');


        /*-------------------
            verifyAdmin
         --------------------*/
        const verifyAdmin = async (req, res, next) => {
            const requester = req.decoded.email;
            const requesterAccount = await userCollection.findOne({ email: requester });
            if (requesterAccount.role === 'admin') {
                next();
            }
            else {
                res.status(403).send({ message: 'forbidden' });
            }
        }

        /*-------------------
            Services API
         --------------------*/
        app.get('/service', async (req, res) => {
            const query = {};
            const cursor = serviceCollection.find(query).project({ name: 1 });
            const services = await cursor.toArray();
            res.send(services);
        });

        /*--------------
            Users API
         ---------------*/

        app.get('/user', verifyJWT, async (req, res) => {
            const users = await userCollection.find().toArray();
            res.send(users);
        })

        app.get('/admin/:email', async (req, res) => {
            const email = req.params.email;
            const user = await userCollection.findOne({ email: email });
            const isAdmin = user.role === 'admin';
            res.send({ admin: isAdmin })
        })

        app.put('/user/admin/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const updateDoc = {
                $set: { role: 'admin' },
            };
            const result = await userCollection.updateOne(filter, updateDoc);
            res.send(result);
        })

        app.put('/user/:email', async (req, res) => {
            const email = req.params.email;
            const user = req.body;
            const filter = { email: email };
            const options = { upsert: true };
            const updateDoc = {
                $set: user,
            };
            const result = await userCollection.updateOne(filter, updateDoc, options);
            const token = jwt.sign({ email: email }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' })
            res.send({ result, token });
        })


        /*----------------------
            Available Slots API
         -----------------------*/

        // WARNING  
        // This is not the proper way to query 
        // After learning more about mongodb, use aggregate lookup, pipeline, match, group
        app.get('/available', async (req, res) => {
            const date = req.query.date;

            // step 1: get all services
            const services = await serviceCollection.find().toArray();

            //step 2: get the bookings of that day. Output: [{}, {}, {}, {}, {}, {}]
            const query = { date: date };
            const bookings = await bookingCollection.find(query).toArray();

            // step 3: for each service
            services.forEach(service => {
                // step 4: find bookings for that service. Output: [{}, {}, {}, {}]
                const serviceBookings = bookings.filter(book => book.treatment === service.name);

                // step 5: select slots for the service bookings: ['', '', '', '']
                const bookedSlots = serviceBookings.map(book => book.slot);

                // step 6: select those slots that are not in bookedSlots
                const available = service.slots.filter(slot => !bookedSlots.includes(slot));

                // step 7: set available to slots to make it easier
                service.slots = available;
            });

            res.send(services);
        })

        /*--------------------
            Booked Slots API
         ---------------------*/

        app.get('/booking', verifyJWT, async (req, res) => {
            const patient = req.query.patient;
            const decodedEmail = req.decoded.email;
            if (patient === decodedEmail) {
                const query = { patient: patient };
                const bookings = await bookingCollection.find(query).toArray();
                return res.send(bookings);
            }
            else {
                return res.status(403).send({ message: 'forbidden access' });
            }
        })

        app.post('/booking', async (req, res) => {
            const booking = req.body;
            const query =
            {
                treatment: booking.treatment,
                date: booking.date,
                patient: booking.patient
            }
            const exists = await bookingCollection.findOne(query);
            if (exists) {
                return res.send({ success: false, booking: exists })
            }
            const result = bookingCollection.insertOne(booking);
            console.log("Sending Email")
            sendAppointmentEmail(booking);
            return res.send({ success: true, result })
        });

        /*----------------------
              Doctors API 
         -----------------------*/

        app.get('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
            const doctors = await doctorCollection.find().toArray();
            res.send(doctors);
        })

        app.post('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorCollection.insertOne(doctor);
            res.send(result);
        });

        app.delete('/doctor/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const result = await doctorCollection.deleteOne(filter);
            res.send(result);
        });

    }
    finally {

    }
}

run().catch(console.dir);

// FOR TESTING in Postman

// app.post('/email', async (req, res) => {
//     const booking = req.body;
//     sendAppointmentEmail(booking);
//     res.send({ status: true });
// })

app.get('/', (req, res) => {
    res.send('Running Doctors Portal');
});

app.listen(port, () => {
    console.log(`Listening to port ${port}`);
})
