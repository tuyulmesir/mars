const functions = require('firebase-functions');
const admin = require('firebase-admin');
const puppeteer = require('puppeteer');
const moment = require('moment');

admin.initializeApp(functions.config().firebase);

let db = admin.firestore();

class Pegipegi {
  static async findCheapestFlights(
      departureDate,
      source = "CGK",
      destination = "DPS"
  ) {
    departureDate = moment(departureDate).format("DD-MM-YYYY");
    const db = admin.firestore();
    const doc = await db
        .collection("priceCache")
        .doc(`${source}-${destination}:${departureDate}`)
        .get();
    if (doc.exists && doc.data().invalidates > Date.now()) return doc.data();
    const url =
        `https://www.pegipegi.com/tiket-pesawat/sys/search-results/` +
        `${source}/${destination}/` +
        `${departureDate}/` +
        `1/0/0`;
    console.log(url);
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitFor(
        () => document.querySelector(".bar-percentage").innerText === "100%"
    );
    await page.waitFor(500);
    let cheapestFlights = await page.evaluate(() => {
      const flights = document.querySelectorAll(".detailOrderList");
      const big = Number.MAX_SAFE_INTEGER;
      let [morning, noon, evening] = [
        { price: big },
        { price: big },
        { price: big }
      ];
      for (let flight of flights) {
        const deconstructedId = flight.id.split("_");
        const departureTime = deconstructedId[deconstructedId.length - 2];
        const arrivalTime = deconstructedId[deconstructedId.length - 1];
        const planeId = deconstructedId[deconstructedId.length - 3];
        const price = parseInt(flight.getAttribute("data-price"));
        const current = {
          departureTime,
          arrivalTime,
          planeId,
          price,
          source: "pegipegi"
        };

        if (departureTime < "0800") {
          if (morning.price > price) morning = current;
        } else if (departureTime < "1600") {
          if (noon.price > price) noon = current;
        } else {
          if (evening.price > price) evening = current;
        }
      }
      return { morning, noon, evening };
    });
    await browser.close();
    db.collection("priceCache")
        .doc(`${source}-${destination}:${departureDate}`)
        .set({
          ...cheapestFlights,
          invalidates: Date.now() + 24 * 60 * 60 * 1000
        });
    return cheapestFlights;
  }
}

exports.getTrips = functions.https.onRequest(async (req, res) => {
  const db = admin.firestore();
  const snapshot = await db.collection("trips").get();
  let trips = [];
  snapshot.forEach(doc => trips.push({ ...doc.data(), id: doc.id }));

  let tripFlightPair = [];
  for (let trip of trips) {
    const startDate = new Date(parseInt(req.query.start));
    const endDate = moment(startDate).add(trip.durations, "days");
    let arrival = Pegipegi.findCheapestFlights(
        startDate,
        trip.source,
        trip.destination
    );
    let departure = Pegipegi.findCheapestFlights(
        endDate,
        trip.source,
        trip.destination
    );
    // eslint-disable-next-line no-await-in-loop
    arrival = (await arrival).morning;
    // eslint-disable-next-line no-await-in-loop
    departure = (await departure).evening;
    tripFlightPair.push({ ...trip, arrival, departure });
  }
  res.send(tripFlightPair);
});


exports.purchaseTrip = functions.https.onRequest(async (req, res) => {
  const currentUser = "MKR1tZiG5FcE8uMe7lCK";
  const tripId = req.query.id;
  const trip = await db
      .collection("trips")
      .doc(tripId)
      .get();
  const startDate = new Date(parseInt(req.query.start));
  const endDate = moment(startDate).add(trip.durations, "days");
  let arrival = Pegipegi.findCheapestFlights(
      startDate,
      trip.source,
      trip.destination
  );
  let departure = Pegipegi.findCheapestFlights(
      endDate,
      trip.source,
      trip.destination
  );
  // eslint-disable-next-line no-await-in-loop
  arrival = (await arrival).morning;
  // eslint-disable-next-line no-await-in-loop
  departure = (await departure).evening;
  await db
      .collection("users")
      .doc(currentUser)
      .update({
        purchased: admin.firestore.FieldValue.arrayUnion({
          ...trip.data(),
          arrival,
          departure
        })
      });
  return res.send({ ...trip.data(), arrival, departure });
});

exports.getPurchased = functions.https.onRequest(async (req, res) => {
  const currentUser = "MKR1tZiG5FcE8uMe7lCK";
  const db = admin.firestore();
  let snapshot = await db.collection("users").doc(currentUser).get();
  let trips = snapshot.data().purchased;
  res.send(trips);
});
