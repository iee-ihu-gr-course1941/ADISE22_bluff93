'use strict';
const express = require('express');
const mysql = require('@mysql/xdevapi');
const _ = require('lodash');
const app = express();

const PORT = 30000;
const TOTAL_PLAYERS_IN_GAME = 2;

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

const findNextPlayerOrder = (session, gameId, lastPlayer) => {
    if (!lastPlayer) {
        return Promise.resolve(1);
    }

    return session
        .sql(
            `SELECT user_order FROM game_user_sequence
            WHERE game_id=${gameId} AND user_id=${lastPlayer[1]};`
        )
        .execute()
        .then(result => {
            const lastPlayerOrder = result.fetchOne()[0];
            return lastPlayerOrder === TOTAL_PLAYERS_IN_GAME ? 1 : lastPlayerOrder + 1;
        });
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

const getUserCards = (session, gameId, userId) => {
    // find largest id from "current" game_hand and resolve foreign keys with joins
    // in order to get user's current cards
    // TODO: check if works afterwards
    return session
        .sql(
            `SELECT card.id as id, card_shape.name as shape, card_symbol.name as symbol FROM card
            INNER JOIN card_symbol ON card.symbol_id=card_symbol.id
            INNER JOIN card_shape ON card.shape_id=card_shape.id
            WHERE card.id IN (
            SELECT card_id FROM game_hand_user_card
            WHERE game_hand_id IN (
            SELECT max(id)
            FROM game_hand
            WHERE game_id=${gameId} AND user_id=${userId} AND type="current"))
            ORDER BY shape;`
        )
        .execute()
        .then(result => {
            return result.fetchAll().map(([id, shape, symbol]) => ({ id, shape, symbol }));
        });
};

mysql.getSession(config).then(
    s => {
        app.set('json spaces', 2);

        app.get('/rules', (_req, res) => {
            res.send({
                rules:
                    'Καλως ηρθατε στην Μπλοφα. Οι κανονες ειναι: ' +
                    `1. Το παιχνιδι παιζεται με ${TOTAL_PLAYERS_IN_GAME} παικτες. ` +
                    '2. Χρησιμοποιειται μονο μια τραπουλα σε καθε παιχνιδι και ολοι οι παικτες μοιραζονται ιδιο αριθμο χαρτιων. ' +
                    '3. Σε καθε γυρο ο παικτης πρεπει να ανακοινωσει ποια χαρτια ' +
                    'θελει να πεταξει, ποσα χαρτια + ποιο ειδος χαρτιου, π.χ. 3 βαλεδες. ' +
                    'Αυτα τα χαρτια δεν ειναι απαραιτητο να ταιριαζουν με τα χαρτια που οντως θα ριξει. ' +
                    '4. Οταν συμπληρωθουν οι παικτες σε ενα συγκεκριμενο παιχνιδι, το παιχνιδι ξεκιναει αυτοματα.',
            });
        });

        app.get('/login', (req, res) => {
            const name = req.query.name;

            if (!name) {
                handleError(res, 'name request param missing', 'GET /login?name=');
                return;
            }

            // insert new user to db
            s.sql(`INSERT INTO user (name) VALUES ("${name}");`)
                .execute()
                .then(
                    result => {
                        const userId = result.getAutoIncrementValue();

                        // check which games await for users (not full)
                        s.sql(
                            `SELECT game_id, COUNT(*) as count from game_user_sequence GROUP BY game_id HAVING count < ${TOTAL_PLAYERS_IN_GAME};`
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

            getUser(s, userId)
                .then(userId => {
                    // create new game in db
                    s.sql(
                        `INSERT INTO game (created_by_user_id, creation_date) VALUES (${userId}, "${new Date()
                            .toISOString()
                            // remove milliseconds
                            .slice(0, 19)
                            .replace('T', ' ')}");`
                    )
                        .execute()
                        .then(
                            result => {
                                const gameId = result.getAutoIncrementValue();

                                createGameUserSequence(s, gameId, userId, 1)
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
                handleError(res, 'userId or gameId request param missing', 'GET /join-game?userId=&gameId=');
                return;
            }

            getUser(s, userId)
                .then(userId => {
                    // search for game
                    s.sql(`SELECT id from game WHERE id=${gameId};`)
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

                            // check if user is indeed in the game
                            s.sql(
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
                                    s.sql(
                                        `SELECT game_id, COUNT(*) as count from game_user_sequence WHERE game_id=${gameId} GROUP BY game_id HAVING count < ${TOTAL_PLAYERS_IN_GAME};`
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

                                            // find existing users in game to determine new user's order/sequence
                                            s.sql(
                                                `SELECT user_id, user_order from game_user_sequence WHERE game_id=${gameId} ORDER BY user_order;`
                                            )
                                                .execute()
                                                .then(
                                                    result => {
                                                        const usersInGame = result.fetchAll();
                                                        const lastUserOrder =
                                                            usersInGame[usersInGame.length - 1];
                                                        const userOrder = lastUserOrder[1] + 1;

                                                        createGameUserSequence(s, gameId, userId, userOrder)
                                                            .then(() => {
                                                                if (
                                                                    usersInGame.length + 1 !==
                                                                    TOTAL_PLAYERS_IN_GAME
                                                                ) {
                                                                    res.send({
                                                                        message:
                                                                            `You have successfully joined the game with gameId=${gameId}. ` +
                                                                            `Your sequence order is ${userOrder}.`,
                                                                        userId,
                                                                        gameId,
                                                                        userOrder,
                                                                    });
                                                                    return;
                                                                }

                                                                // check if game is full to give out the cards
                                                                s.sql('SELECT id from card;')
                                                                    .execute()
                                                                    .then(result => {
                                                                        const shuffledCards = _.shuffle(
                                                                            result.fetchAll()
                                                                        );

                                                                        const userIds = usersInGame
                                                                            .map(u => u[0])
                                                                            .concat(userId);

                                                                        const noCardsPerUser = Math.floor(
                                                                            shuffledCards.length /
                                                                                TOTAL_PLAYERS_IN_GAME
                                                                        );

                                                                        // structure like {1: [1,3,7,17,16], 2: [5,2,6,8,9]}
                                                                        const cardsPerUser = userIds.reduce(
                                                                            (acc, userId) => {
                                                                                // take the amount of cards
                                                                                acc[userId] = _.take(
                                                                                    shuffledCards,
                                                                                    noCardsPerUser
                                                                                );

                                                                                // and remove them from the list of cards
                                                                                shuffledCards.splice(
                                                                                    0,
                                                                                    noCardsPerUser - 1
                                                                                );

                                                                                return acc;
                                                                            },
                                                                            {}
                                                                        );

                                                                        Promise.all(
                                                                            userIds.map(id => {
                                                                                // create row with type="current"
                                                                                s.sql(
                                                                                    `INSERT INTO game_hand (game_id, user_id, type) VALUES (${gameId}, ${id}, "current");`
                                                                                )
                                                                                    .execute()
                                                                                    .then(
                                                                                        result => {
                                                                                            const gameHandId =
                                                                                                result.getAutoIncrementValue();

                                                                                            // store user's current cards
                                                                                            return s
                                                                                                .sql(
                                                                                                    `INSERT INTO game_hand_user_card (game_hand_id, user_id, card_id) VALUES ${cardsPerUser[
                                                                                                        id
                                                                                                    ]
                                                                                                        .map(
                                                                                                            card =>
                                                                                                                `(${gameHandId}, ${id}, ${card[0]})`
                                                                                                        )
                                                                                                        .join(
                                                                                                            ','
                                                                                                        )};`
                                                                                                )
                                                                                                .execute();
                                                                                        },
                                                                                        error => {
                                                                                            handleError(
                                                                                                res,
                                                                                                error,
                                                                                                'GET /join-game?userId=&gameId='
                                                                                            );
                                                                                        }
                                                                                    );
                                                                            })
                                                                        ).then(
                                                                            () => {
                                                                                res.send({
                                                                                    message:
                                                                                        `You have successfully joined the game with gameId=${gameId}. ` +
                                                                                        `Your sequence order is ${userOrder}.`,
                                                                                    userId,
                                                                                    gameId,
                                                                                    userOrder,
                                                                                });
                                                                                return;
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

        app.get('/my-cards', (req, res) => {
            const userId = req.query.userId;
            const gameId = req.query.gameId;

            if (!userId || !gameId) {
                handleError(res, 'userId or gameId request param missing', 'GET /my-cards?userId=&gameId=');
                return;
            }

            getUserCards(s, gameId, userId).then(
                myCards => {
                    // get all deck cards
                    s.sql(
                        `SELECT card.id as id, card_shape.name as shape, card_symbol.name as symbol FROM card
                            INNER JOIN card_symbol ON card.symbol_id=card_symbol.id
                            INNER JOIN card_shape ON card.shape_id=card_shape.id
                            ORDER BY symbol;`
                    )
                        .execute()
                        .then(result => {
                            const allCards = result
                                .fetchAll()
                                .map(([id, shape, symbol]) => ({ id, shape, symbol }));

                            res.send({
                                myCards,
                                userId,
                                gameId,
                                allCards,
                            });
                        });
                },
                error => {
                    handleError(res, error, 'GET /my-cards?userId=&gameId=');
                }
            );
        });

        app.get('/throw', (req, res) => {
            const userId = req.query.userId;
            const gameId = req.query.gameId;
            const actual = req.query.actual;
            const quantityStr = req.query.quantity;
            const shape = req.query.shape;

            if (!userId || !gameId || !quantityStr || !shape || !actual) {
                handleError(
                    res,
                    'userId, gameId, quantity, shape or actual request param missing',
                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                );
                return;
            }

            const cardsIds = actual.split(',');
            const quantity = Number(quantityStr);

            if (!_.isNumber(quantity)) {
                handleError(
                    res,
                    'quantity is not a number',
                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                );
                return;
            }

            if (quantity < 1 || quantity > 4) {
                handleError(
                    res,
                    'quantity needs to be >=1 and <=4',
                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                );
                return;
            }

            if (quantity !== cardsIds.length) {
                handleError(
                    res,
                    "provided amount of cards ids doesn't match quantity",
                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                );
                return;
            }

            s.sql(`SELECT id FROM card_shape WHERE name="${shape}";`)
                .execute()
                .then(result => {
                    const cardShape = result.fetchAll();

                    if (!cardShape.length) {
                        handleError(
                            res,
                            "provided shape doesn't exist",
                            'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                        );
                        return;
                    }

                    s.sql(
                        `SELECT id, user_id FROM game_hand
                            WHERE type="thrown" OR type="challenged" AND game_id=${gameId}
                            ORDER BY id DESC
                            LIMIT 1;`
                    )
                        .execute()
                        .then(
                            result => {
                                findNextPlayerOrder(s, gameId, result.fetchOne()).then(
                                    order => {
                                        s.sql(
                                            `SELECT * FROM game_user_sequence
                                        WHERE game_id=${gameId} AND user_id=${userId} AND user_order=${order}
                                        LIMIT 1;`
                                        )
                                            .execute()
                                            .then(
                                                result => {
                                                    const nextPlayer = result.fetchOne();

                                                    if (!nextPlayer) {
                                                        handleError(
                                                            res,
                                                            'you are not the next player',
                                                            'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                                        );
                                                        return;
                                                    }

                                                    // it's this player's order
                                                    // make sure provided card ids are in the player's hands
                                                    getUserCards(s, gameId, userId).then(
                                                        myCards => {
                                                            if (
                                                                cardsIds.every(id =>
                                                                    myCards.find(c => c.id === id)
                                                                )
                                                            ) {
                                                                handleError(
                                                                    res,
                                                                    'some of the provided cards ids do not belong to you',
                                                                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                                                );
                                                                return;
                                                            }

                                                            s.sql(
                                                                `INSERT INTO game_hand (game_id, user_id, type) VALUES (${gameId}, ${userId}, "thrown");`
                                                            )
                                                                .execute()
                                                                .then(result => {
                                                                    const gameHandId =
                                                                        result.getAutoIncrementValue();
                                                                    const requestedShapeId = cardShape[0];

                                                                    // find random ids for provided shape and limit by quantity
                                                                    s.sql(
                                                                        `SELECT id FROM card WHERE shape_id=${requestedShapeId} LIMIT ${quantity};`
                                                                    )
                                                                        .execute()
                                                                        .then(
                                                                            result => {
                                                                                const quantityRange = _.range(
                                                                                    0,
                                                                                    quantity
                                                                                );
                                                                                const randomShapeCardIds =
                                                                                    result
                                                                                        .fetchAll()
                                                                                        .map(x => x[0]);
                                                                                const actualRows =
                                                                                    quantityRange.map(
                                                                                        i =>
                                                                                            `(${gameHandId}, ${cardsIds[i]}, "actual")`
                                                                                    );
                                                                                const saidRows =
                                                                                    quantityRange.map(
                                                                                        i =>
                                                                                            `(${gameHandId}, ${randomShapeCardIds[i]}, "said")`
                                                                                    );

                                                                                // insert many into game_hand_card
                                                                                s.sql(
                                                                                    `INSERT INTO game_hand_card (game_hand_id, card_id, type) VALUES ${[
                                                                                        actualRows.join(','),
                                                                                        saidRows.join(','),
                                                                                    ].join(',')};`
                                                                                )
                                                                                    .execute()
                                                                                    .then(
                                                                                        () => {
                                                                                            // find after throw which cards are left in player's hand
                                                                                            const updatedUserCards =
                                                                                                myCards.filter(
                                                                                                    c =>
                                                                                                        !cardsIds.includes(
                                                                                                            c.id.toString()
                                                                                                        )
                                                                                                );

                                                                                            // insert new row for type=current
                                                                                            s.sql(
                                                                                                `INSERT INTO game_hand (game_id, user_id, type)
                                                                                                VALUES (${gameId}, ${userId}, "current");`
                                                                                            )
                                                                                                .execute()
                                                                                                .then(
                                                                                                    result => {
                                                                                                        const currentGameHandId =
                                                                                                            result.getAutoIncrementValue();
                                                                                                        const cardRows =
                                                                                                            updatedUserCards.map(
                                                                                                                c =>
                                                                                                                    `(${currentGameHandId}, ${userId}, ${c.id})`
                                                                                                            );

                                                                                                        // insert remaining user cards for game_hand_id
                                                                                                        s.sql(
                                                                                                            `INSERT INTO game_hand_user_card (game_hand_id, user_id, card_id) VALUES ${cardRows.join(
                                                                                                                ','
                                                                                                            )};`
                                                                                                        )
                                                                                                            .execute()
                                                                                                            .then(
                                                                                                                () => {
                                                                                                                    res.send(
                                                                                                                        {
                                                                                                                            message:
                                                                                                                                'Your turn was successfull',
                                                                                                                            myCards:
                                                                                                                                updatedUserCards,
                                                                                                                            gameId,
                                                                                                                            userId,
                                                                                                                        }
                                                                                                                    );
                                                                                                                },
                                                                                                                error => {
                                                                                                                    handleError(
                                                                                                                        res,
                                                                                                                        error,
                                                                                                                        'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                                                                                                    );
                                                                                                                }
                                                                                                            );
                                                                                                    },
                                                                                                    error => {
                                                                                                        handleError(
                                                                                                            res,
                                                                                                            error,
                                                                                                            'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                                                                                        );
                                                                                                    }
                                                                                                );
                                                                                        },
                                                                                        error => {
                                                                                            handleError(
                                                                                                res,
                                                                                                error,
                                                                                                'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                                                                            );
                                                                                        }
                                                                                    );
                                                                            },
                                                                            error => {
                                                                                handleError(
                                                                                    res,
                                                                                    error,
                                                                                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                                                                );
                                                                            }
                                                                        );
                                                                });
                                                        },
                                                        error => {
                                                            handleError(
                                                                res,
                                                                error,
                                                                'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                                            );
                                                        }
                                                    );
                                                },
                                                error => {
                                                    handleError(
                                                        res,
                                                        error,
                                                        'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                                    );
                                                }
                                            );
                                    },
                                    error => {
                                        handleError(
                                            res,
                                            error,
                                            'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                        );
                                    }
                                );
                            },
                            error => {
                                handleError(
                                    res,
                                    error,
                                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                                );
                            }
                        );
                });
        });

        app.get('/challenge');
    },
    error => {
        console.error(error);
    }
);

app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
});
