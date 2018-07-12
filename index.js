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
app.set("view engine", "pug");

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
const hireEquipmentApiUrl =
	"http://zokal-googlesheets-hire-api.webriq.com/sheet";

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
				? 0
				: parseInt(req.body.additional_persons_count),
		price: parseFloat(await getBookingPriceById(parseInt(req.body.id))),
		stripeToken: req.body.stripeToken,
		student_details: req.body.student_details,
		additional_persons: req.body.additional_persons
	};
	// Individual equate to 1 and any additional persons will be counted to company
	const bookingTotalPrice =
		booking.price * (booking.additionalPersonsCount + 1);

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
				sendEmail({
					to: booking.email,
					content: req.body,
					res: res
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
				} ${process.env.APP_BOOKING_CURRENCY || "AUD"}
				 for ${
						booking.type === "individual"
							? `1 person`
							: `1 student ${
									booking.additionalPersonsCount > 1
										? ` and ${booking.additionalPersonsCount} persons`
										: `1 person`
							  }`
					}`
			});
		})
		.then(charge => {
			return saveToZokalSheet(booking, req.body, "completed");
		})
		.then(() => {
			// Send email
			sendEmail({
				subject: `${process.env.APP_NAME} | New Booking Payment`,
				headingText: "New Booking Payment",
				to: booking.email,
				content: req.body,
				res: res
			});
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
 * POST /hireEquipment
 */
app.post("/hireEquipment", (req, res) => {
	return axios
		.post(`${hireEquipmentApiUrl}`, req.body)
		.then(function(response) {
			return res.status(200).json({ message: "Success!" });
		})
		.catch(function(error) {
			return res.status(500).json(error);
		});
});

/**
 * Save to Zokal SpreadSheet API Bookings
 *
 * @param  {Object} booking  Booking object containing ID, email, additionalPersonsCount, price, and StripeToken
 * @param  {Object} body Body data and additioanl persons details of the booking
 * @return {}                    [description]
 */
const saveToZokalSheet = async (booking, body, status = "completed") => {
	// Payment type
	const payment_type = status === "completed" ? "payment" : "invoice";

	// Insert student details
	if (booking.student_details) {
		const studentData = {
			first_name: body.student_details.first_name[0],
			last_name: body.student_details.last_name[0],
			email: body.student_details.email[0],
			phone: body.student_details.phone[0],
			gender: body.student_details.gender[0],
			usi: body.student_details.usi[0]
		};
		const finalData = {
			...body,
			...{ price: booking.price }, // update price based on API data
			...{ status: status }, // set status to complete as payment is done
			...{ payment_type: payment_type },
			...studentData
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
			...{ payment_type: payment_type },
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

	// Insert individual person data
	if (booking.type === "individual") {
		await axios
			.post(`${bookingApiUrl}?sheetTitle=Bookings`, {
				...body,
				...{ price: booking.price },
				...{ status: status },
				...{ payment_type: payment_type }
			})
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
const sendEmail = data => {
	const { to, from, subject, cc, content } = data;

	// Convert object to label and value
	const formatDataAsLabelAndValue = obj => {
		var arr = [];
		for (var key in obj) {
			// when individual, remove additional_persons_count, skip
			if (
				obj.type === "individual" &&
				obj.hasOwnProperty(key) &&
				["additional_persons_count", "student_details"].includes(key)
			) {
				continue;
			}

			if (
				obj.hasOwnProperty(key) &&
				![
					"stripeToken",
					"additional_persons",
					"student_details",
					"form-name"
				].includes(key)
			) {
				arr.push(
					`<p><strong>${changeCase.titleCase(key)}</strong>: ${obj[key]}</p>`
				);
			}
		}

		// student details
		if (obj.hasOwnProperty("student_details")) {
			for (var skey in obj["student_details"]) {
				arr.push(
					`<p><strong>Student ${changeCase.titleCase(skey)}</strong>: ${
						obj["student_details"][skey][0]
					}</p>`
				);
			}
		}

		// additional persons
		for (i = 0; i < parseInt(obj.additional_persons_count); i++) {
			for (var key2 in obj["additional_persons"]) {
				if (obj["additional_persons"].hasOwnProperty(key2)) {
					var currentIndex = i + 1;
					arr.push(
						`<p><strong>Additional Person ${currentIndex}: ${changeCase.titleCase(
							key2
						)}</strong>: ${obj["additional_persons"][key2][i]}</p>`
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

	const htmlContent = cleanUpData(formatDataAsLabelAndValue(content));

	data.res.render(
		"emails/invoice",
		{
			content: htmlContent,
			headingText: data.headingText
		},
		function(err, html) {
			var mailOptions = {
				to: to,
				from: from || process.env.APP_EMAIL,
				subject: subject || `${process.env.APP_NAME} | New Invoice Request`,
				cc: cc || process.env.APP_EMAIL_RECIPIENTS,
				html: html
			};

			mailer.sendMail(mailOptions, function(err) {
				if (err) {
					console.log(err);
					return;
				}
			});
		}
	);
};

app.listen(process.env.PORT || 3000, () => {
	console.log(
		"App is running at http://localhost:%d in %s mode",
		process.env.PORT || 3000,
		app.get("env")
	);
});
