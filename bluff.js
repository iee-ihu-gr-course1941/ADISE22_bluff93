'use strict';
const express = require('express');
const mysql = require('@mysql/xdevapi');
const app = express();

const PORT = 30000;

const config = {
    user: 'root',
    password: 'Pmic93nena!',
    schema: 'bluff',
};

const handleError = (res, error, endpoint) => {
    console.error(error);
    const result = { error };

    if (endpoint) {
        result.endpoint = endpoint;
    }

    res.send(result);
};

class UserNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UserNotFoundError';
    }
}

const getUser = (session, userId) => {
    return session
        .sql(`SELECT id from user WHERE id=${userId};`)
        .execute()
        .then(
            result => {
                const userIds = result.fetchAll();

                if (!userIds.length) {
                    throw new UserNotFoundError('User not found!');
                }

                return userIds[0];
            },
            error => {
                throw new Error(error);
            }
        );
};

const createGameUserSequence = (session, gameId, userId, userOrder) => {
    return session
        .sql(
            `INSERT INTO game_user_sequence (game_id, user_id, user_order) VALUES (${gameId}, ${userId}, ${userOrder})`
        )
        .execute()
        .then(
            () => {},
            error => {
                throw new Error(error);
            }
        );
};

mysql.getSession(config).then(
    session => {
        app.get('/rules', (_req, res) => {
            res.send({
                rules:
                    'Καλως ηρθατε στην Μπλοφα. Οι κανονες ειναι: ' +
                    '1. Το παιχνιδι παιζεται με 3 παικτες. ' +
                    '2. Χρησιμοποιειται μονο μια τραπουλα σε καθε παιχνιδι. ' +
                    '3. Σε καθε γυρο ο παικτης πρεπει να ανακοινωσει ποια χαρτια ' +
                    'θελει να πεταξει, ποσα χαρτια + ποιο ειδος χαρτιου, π.χ. 3 βαλεδες. ' +
                    'Αυτα τα χαρτια δεν ειναι απαραιτητο να ταιριαζουν με τα χαρτια που οντως ' +
                    'θα ριξει.',
            });
        });

        app.get('/login', (req, res) => {
            const name = req.query.name;

            if (!name) {
                handleError(res, 'name request param missing', 'GET /login?name=');
                return;
            }

            // insert new user to db
            session
                .sql(`INSERT INTO user (name) VALUES ("${name}");`)
                .execute()
                .then(
                    result => {
                        const userId = result.getAutoIncrementValue();

                        // check which games await for users (not full)
                        session
                            .sql(
                                'SELECT game_id, COUNT(*) as count from game_user_sequence GROUP BY game_id HAVING count < 3;'
                            )
                            .execute()
                            .then(result => {
                                const availableGames = result.fetchAll();
                                const availableGameIds = availableGames.map(game => game[0]);

                                res.send({
                                    message:
                                        `You logged in successfully. Your unique userId is ${userId}. ` +
                                        'You need to remember it for the duration of your game. ' +
                                        `${
                                            availableGameIds.length
                                                ? `There exist the following available games: ${JSON.stringify(
                                                      availableGameIds
                                                  )}. You can either connect to one of them, or create a new game`
                                                : 'There are no available games at the moment. Please create a new game!'
                                        }`,
                                    userId,
                                    name,
                                    availableGameIds,
                                });
                            });
                    },
                    error => {
                        handleError(res, error, 'GET /login?name=');
                    }
                );
        });

        app.get('/new-game', (req, res) => {
            const userId = req.query.userId;

            if (!userId) {
                handleError(res, 'userId request param missing', 'GET /new-game?userId=');
                return;
            }

            getUser(session, userId)
                .then(userId => {
                    session
                        .sql(
                            `INSERT INTO game (created_by_user_id, creation_date) VALUES (${userId}, "${new Date()
                                .toISOString()
                                .slice(0, 19)
                                .replace('T', ' ')}");`
                        )
                        .execute()
                        .then(
                            result => {
                                const gameId = result.getAutoIncrementValue();

                                createGameUserSequence(session, gameId, userId, 1)
                                    .then(() => {
                                        res.send({
                                            message:
                                                `A new game was created successfully. Your game id is ${gameId}. ` +
                                                'You need to remember it for the duration of your game. ' +
                                                'Your sequence order is 1.',
                                            gameId,
                                        });
                                    })
                                    .catch(error => {
                                        handleError(res, error, 'GET /new-game?userId=');
                                    });
                            },
                            error => {
                                handleError(res, error, 'GET /new-game?userId=');
                            }
                        );
                })
                .catch(error => {
                    if (error instanceof UserNotFoundError) {
                        handleError(
                            res,
                            `No user found with id=${userId}. You have to login first`,
                            'GET /login?name='
                        );
                        return;
                    }

                    throw error;
                });
        });

        app.get('/join-game', (req, res) => {
            const userId = req.query.userId;
            const gameId = req.query.gameId;

            if (!userId || !gameId) {
                handleError(
                    res,
                    'userId or gameId request param missing',
                    'GET /join-game?userId=&gameId='
                );
                return;
            }

            // todo: check if user already is in this game
            getUser(session, userId)
                .then(userId => {
                    session
                        .sql(`SELECT id from game WHERE id=${gameId};`)
                        .execute()
                        .then(result => {
                            const allGameIds = result.fetchAll();

                            if (!allGameIds.length) {
                                handleError(
                                    res,
                                    `Game with gameId=${gameId} doesn't exist. Please create a new game.`,
                                    'GET /new-game?userId='
                                );
                                return;
                            }

                            session
                                .sql(
                                    `SELECT * from game_user_sequence WHERE game_id=${gameId} AND user_id=${userId};`
                                )
                                .execute()
                                .then(result => {
                                    const userInGame = result.fetchOne();

                                    if (userInGame) {
                                        handleError(
                                            res,
                                            `User with userId=${userId} is already in the game.`
                                        );
                                        return;
                                    }

                                    // check if game can accept more players or is already full
                                    session
                                        .sql(
                                            `SELECT game_id, COUNT(*) as count from game_user_sequence WHERE game_id=${gameId} GROUP BY game_id HAVING count < 3;`
                                        )
                                        .execute()
                                        .then(result => {
                                            const usersInGame = result.fetchAll();

                                            if (!usersInGame.length) {
                                                handleError(
                                                    res,
                                                    `Game with gameId=${gameId} is full. Please create a new game or join another one.`,
                                                    'GET /new-game?userId= , GET /join-game?userId=&gameId='
                                                );
                                                return;
                                            }

                                            session
                                                .sql(
                                                    `SELECT user_order from game_user_sequence WHERE game_id=${gameId} ORDER BY user_order;`
                                                )
                                                .execute()
                                                .then(
                                                    result => {
                                                        const usersInGame = result.fetchAll();
                                                        const lastUserOrder =
                                                            usersInGame[usersInGame.length - 1];
                                                        const userOrder = lastUserOrder[0] + 1;

                                                        createGameUserSequence(
                                                            session,
                                                            gameId,
                                                            userId,
                                                            userOrder
                                                        )
                                                            .then(() => {
                                                                res.send({
                                                                    message:
                                                                        `You have successfully joined the game with gameId=${gameId}. ` +
                                                                        `Your sequence order is ${userOrder}.`,
                                                                    userId,
                                                                    gameId,
                                                                    userOrder,
                                                                });
                                                            })
                                                            .catch(error => {
                                                                handleError(
                                                                    res,
                                                                    error,
                                                                    'GET /join-game?userId=&gameId='
                                                                );
                                                            });
                                                    },
                                                    error => {
                                                        handleError(
                                                            res,
                                                            error,
                                                            'GET /join-game?userId=&gameId='
                                                        );
                                                    }
                                                );
                                        });
                                });
                        });
                })
                .catch(error => {
                    if (error instanceof UserNotFoundError) {
                        handleError(
                            res,
                            `No user found with id=${userId}. You have to login first`,
                            'GET /login?name='
                        );
                        return;
                    }

                    throw error;
                });
        });
    },
    error => {
        console.error(error);
    }
);

app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
});
