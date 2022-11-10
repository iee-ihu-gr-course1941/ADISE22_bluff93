"use strict";
const express = require('express');
const app = express();
const PORT = 15000;
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
app.get('/', (req, res) => {
    res.send('Hello World!')
});

app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
});