const express = require("express");
const bodyParser = require("body-parser");
const helmet = require("helmet");
const cors = require("cors");
const { check, validationResult } = require("express-validator/check");
const axios = require("axios");

const app = express();

/** Load .env file */
require("dotenv").config();

const stripe = require("stripe")(
	process.env.STRIPE_SECRET || "sk_test_Aq19layG1K6gw7Xj6gI2Thi1"
);

app.use(helmet());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

/**
 * Allow cors only from the list in .env
 */
const whitelistedUrl = process.env.CORS_ALLOWED_URL.split(",");
var corsOptions = {
	origin: function(origin, callback) {
		if (whitelistedUrl.indexOf(origin) !== -1) {
			callback(null, true);
		} else {
			callback(new Error("Not allowed by CORS"));
		}
	}
};
app.use(cors(corsOptions));
const bookingApiUrl = "http://zokal-googlesheets-api.webriq.com/sheet";
const bookingTypes = ["individual", "company"];

app.post(
	"/processPayment",
	[
		check("id", "Booking ID is required!").exists(),
		check("stripeToken", "Stripe token is required!").exists(),
		check("type", "Booking type is invalid!")
			.exists()
			.custom((value, { req }) => bookingTypes.includes(value)),
		check("email", "Email is required for individual type!").custom(
			(value, { req }) => {
				if (req.body.type === "individual") {
					return !!value;
				}

				return true;
			}
		),
		check(
			"business_email",
			"Business email is required for company type!"
		).custom((value, { req }) => {
			if (req.body.type === "company") {
				return !!value;
			}

			return true;
		})
	],
	async (req, res) => {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(422).json({ errors: errors.array() });
		}

		// console.log(req.body);

		// Retrieve price from Zokal SpreadSheet API
		const getBookingPriceById = id => {
			return axios
				.get(`${bookingApiUrl}`)
				.then(res => res.data.find(booking => booking.id == id).price);
		};

		// Construct booking data
		const booking = {
			id: parseInt(req.body.id),
			type: req.body.type,
			email:
				req.body.type === "individual"
					? req.body.email
					: req.body.business_email,
			additionalPersonsCount:
				req.body.type === "individual"
					? 1
					: parseInt(req.body.additional_persons_count),
			price: parseFloat(await getBookingPriceById(parseInt(req.body.id))),
			stripeToken: req.body.stripeToken
		};
		const bookingTotalPrice = booking.price * booking.additionalPersonsCount;

		// Save to Zokal SpreadSheet API Bookings
		const saveToZokalSheet = async booking => {
			for (i = 0; i <= parseInt(booking.additionalPersonsCount) - 1; i++) {
				const personData =
					booking.type !== "individual"
						? {
								first_name: req.body.additional_persons.first_name[i],
								last_name: req.body.additional_persons.last_name[i],
								email: req.body.additional_persons.email[i],
								phone: req.body.additional_persons.phone[i],
								gender: req.body.additional_persons.gender[i],
								usi: req.body.additional_persons.usi[i]
						  }
						: {};
				const finalData = Object.assign(
					req.body,
					{ price: booking.price }, // update price based on API data
					{ status: "completed" }, // set status to complete as payment is done
					personData
				);

				// POST to Zokal Sheets API
				await axios
					.post(`${bookingApiUrl}?sheetTitle=Bookings`, finalData)
					.then(function(response) {
						return response;
					})
					.catch(function(error) {
						return error;
					});
			}
		};

		// Save customer and charge
		return stripe.customers
			.create({
				// Save customer
				email: booking.email,
				source: booking.stripeToken
				// metadata: metadata,
			})
			.then(customer => {
				// Charge customer
				return stripe.charges.create({
					amount: bookingTotalPrice * 100, // stripe amounts in cents
					currency: process.env.APP_BOOKING_CURRENCY || "AUD",
					customer: customer.id,
					description: `Payment for booking id: ${booking.id} with price of ${
						booking.price
					} for ${booking.additionalPersonsCount} person(s)`
				});
			})
			.then(charge => {
				return saveToZokalSheet(booking);
			})
			.then(() => {
				return res.json({ message: "OK. Successfully processed payment!" });
			})
			.catch(err => {
				return res.status(500).json(err);
			});

		// send webhook containing details
	}
);

app.listen(process.env.PORT || 3000, () => {
	console.log(
		"App is running at http://localhost:%d in %s mode",
		process.env.PORT || 3000,
		app.get("env")
	);
});
