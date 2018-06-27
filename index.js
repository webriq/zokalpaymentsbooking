const express = require("express");
const bodyParser = require("body-parser");
const helmet = require("helmet");
const cors = require("cors");
const { check, validationResult } = require("express-validator/check");
const axios = require("axios");
const changeCase = require("change-case");

const app = express();

/** Load .env file */
require("dotenv").config();

const mailer = require("./mailer");
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

/**
 * Validate form submission through the following filters below
 */
const validateFormRequest = [
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
];

/**
 * POST /processPayment
 */
app.post("/processPayment", validateFormRequest, async (req, res) => {
	const errors = validationResult(req);
	if (!errors.isEmpty()) {
		return res.status(422).json({ errors: errors.array() });
	}

	console.log(req.body);

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
			req.body.type === "individual" ? req.body.email : req.body.business_email,
		additionalPersonsCount:
			req.body.type === "individual"
				? 1
				: parseInt(req.body.additional_persons_count),
		price: parseFloat(await getBookingPriceById(parseInt(req.body.id))),
		stripeToken: req.body.stripeToken
	};
	const bookingTotalPrice = booking.price * booking.additionalPersonsCount;

	// Determine request whether payment or invoice
	const isInvoiceRequest =
		req.body && req.body.stripeToken === "" ? true : false;

	// Send invoice and create a pending booking
	if (isInvoiceRequest) {
		return saveToZokalSheet(booking, req.body, "pending")
			.then(() => {
				return res.json({ message: "OK. Successfully processed payment!" });
			})
			.then(() => {
				// Send email
				sendEmailInvoice({
					to: booking.email,
					content: req.body
				});
			});
		return; // safeguard
	}

	// Charge customer and mark booking as complete
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
			return saveToZokalSheet(booking, req.body, "completed");
		})
		.then(() => {
			return res.json({ message: "OK. Successfully processed payment!" });
		})
		.catch(err => {
			return res.status(500).json(err);
		});

	// send webhook containing details
});

/**
 * Save to Zokal SpreadSheet API Bookings
 *
 * @param  {Object} booking  Booking object containing ID, email, additionalPersonsCount, price, and StripeToken
 * @param  {Object} body Body data and additioanl persons details of the booking
 * @return {}                    [description]
 */
const saveToZokalSheet = async (booking, body, status = "completed") => {
	for (i = 0; i <= parseInt(booking.additionalPersonsCount) - 1; i++) {
		const personData =
			booking.type !== "individual"
				? {
						first_name: body.additional_persons.first_name[i],
						last_name: body.additional_persons.last_name[i],
						email: body.additional_persons.email[i],
						phone: body.additional_persons.phone[i],
						gender: body.additional_persons.gender[i],
						usi: body.additional_persons.usi[i]
				  }
				: {};
		const finalData = {
			...body,
			...{ price: booking.price }, // update price based on API data
			...{ status: status }, // set status to complete as payment is done
			...personData
		};

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

/**
 * Send email invoice
 */
const sendEmailInvoice = data => {
	console.log(data);
	const { to, from, subject, content } = data;

	// Convert object to label and value
	const formatDataAsLabelAndValue = obj => {
		var arr = [];
		for (var key in obj) {
			if (
				obj.hasOwnProperty(key) &&
				!["stripeToken", "additional_persons"].includes(key)
			) {
				arr.push(
					`<p><strong>${changeCase.titleCase(key)}</strong>: ${obj[key]}</p>`
				);
			}
		}

		// additional persons
		for (i = 1; i <= obj.additional_persons_count; i++) {
			for (var key2 in obj["additional_persons"]) {
				if (obj["additional_persons"].hasOwnProperty(key2)) {
					var currentIndex = i - 1;
					arr.push(
						`<p><strong>Additional Person ${changeCase.titleCase(
							key2
						)} ${i}</strong>: ${
							obj["additional_persons"][key2][currentIndex]
						}</p>`
					);
				}
			}
		}

		return arr.join("");
	};

	const cleanUpData = obj => {
		delete obj["stripeToken"];

		return obj;
	};

	var mailOptions = {
		to: to,
		from: from || process.env.APP_EMAIL,
		subject: subject || `${process.env.APP_NAME} | New Invoice Request`,
		html: `
			<h3>Please see following details provided below:</h3>
			${cleanUpData(formatDataAsLabelAndValue(content))}
		`
	};
	mailer.sendMail(mailOptions, function(err) {
		if (err) {
			console.log(err);
			return;
		}
	});
};

app.listen(process.env.PORT || 3000, () => {
	console.log(
		"App is running at http://localhost:%d in %s mode",
		process.env.PORT || 3000,
		app.get("env")
	);
});
