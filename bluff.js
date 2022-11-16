"use strict";
const express = require('express');
const app = express();
const PORT = 30000;
// const mysql = require('@mysql/xdevapi');

// const config = {
//     host: 'it113752@users.iee.ihu.gr',
//     port: 33060,
//     user: 'root',
//     password: 'Pmic93nena!',
//     schema: 'bluff',
//     socket: '/home/student/it/2011/it113752/mysql/run/mysql.sock'
// }

// mysql.getSession(config).then((session) => {
//     console.log(session.close);
// }, (error) => {
//     console.log(error)
// });
app.get('/rules', (_req, res) => {
    res.send({
        rules: 'Καλως ηρθατε στην Μπλοφα. Οι κανονες ειναι: ' +
            '1. Το παιχνιδι παιζεται με 3 παικτες. ' +
            '2. Χρησιμοποιειται μονο μια τραπουλα σε καθε παιχνιδι. ' +
            '3. Σε καθε γυρο ο παικτης πρεπει να ανακοινωσει ποια χαρτια ' +
            'θελει να πεταξει, ποσα χαρτια + ποιο ειδος χαρτιου, π.χ. 3 βαλεδες. ' +
            'Αυτα τα χαρτια δεν ειναι απαραιτητο να ταιριαζουν με τα χαρτια που οντως ' +
            'θα ριξει.'
    })
});

app.get('/login', (req, res) => {
    const name = req.query.name;

    if (!name) {
        res.send({ error: "A player name needs to be provided", endpoint: "GET /login?name=" });
        return;
    }

    // create user in user table and return unique ide
    // INSERT INTO user (name) VALUES (${name});
    // SELECT LAST_INSERT_ID();

    // SELECT game_id, COUNT(*) as count from game_user_sequence GROUP BY game_id HAVING count < 3;

    const availableGameIds = [1, 2, 3];
    const userId = 1234;
    res.send({
        message: `You logged in successfully. Your unique userId is ${userId}. ` +
            'You need to remember it for the duration of your game', userId, name, availableGameIds
    })
});

app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
});