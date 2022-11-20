"use strict";
const express = require("express");
const mysql = require("@mysql/xdevapi");
const app = express();

const PORT = 30000;

const config = {
    user: "root",
    password: "Pmic93nena!",
    schema: "bluff",
};

const handleError = (res, error, endpoint) => {
    console.error(error);
    res.send({ error, endpoint });
}

mysql.getSession(config).then(
    (session) => {
        app.get("/rules", (_req, res) => {
            res.send({
                rules:
                    "Καλως ηρθατε στην Μπλοφα. Οι κανονες ειναι: " +
                    "1. Το παιχνιδι παιζεται με 3 παικτες. " +
                    "2. Χρησιμοποιειται μονο μια τραπουλα σε καθε παιχνιδι. " +
                    "3. Σε καθε γυρο ο παικτης πρεπει να ανακοινωσει ποια χαρτια " +
                    "θελει να πεταξει, ποσα χαρτια + ποιο ειδος χαρτιου, π.χ. 3 βαλεδες. " +
                    "Αυτα τα χαρτια δεν ειναι απαραιτητο να ταιριαζουν με τα χαρτια που οντως " +
                    "θα ριξει.",
            });
        });

        app.get("/login", (req, res) => {
            const name = req.query.name;

            if (!name) {
                handleError(res, error, "GET /login?name=");
                return;
            }

            // insert new user to db
            session.sql(`INSERT INTO user (name) VALUES ("${name}");`)
                .execute()
                .then((result) => {
                    const userId = result.getAutoIncrementValue();

                    // check which games await for users (not full)
                    session.sql('SELECT game_id, COUNT(*) as count from game_user_sequence GROUP BY game_id HAVING count < 3;')
                        .execute()
                        .then((result) => {
                            const availableGameIds = result.fetchAll();

                            res.send({
                                message:
                                    `You logged in successfully. Your unique userId is ${userId}. ` +
                                    "You need to remember it for the duration of your game. " + `${availableGameIds.length ? `There exist the following available games: ${JSON.stringify(availableGameIds)}. You can either connect to one of them, or create a new game` : 'There are no available games at the moment. Please create a new game!'}`,
                                userId,
                                name,
                                availableGameIds,
                            });
                        });
                }, error => {
                    handleError(res, error, "GET /login?name=");
                });
        });
    },
    (error) => {
        console.error(error);
    }
);

app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
});
