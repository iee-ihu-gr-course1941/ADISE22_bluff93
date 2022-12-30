'use strict';
const express = require('express');
const mysql = require('@mysql/xdevapi');
const _ = require('lodash');
const app = express();

const PORT = 30000;
const TOTAL_PLAYERS_IN_GAME = 2;

const CONFIG = {
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

const checkUserExistence = async (session, userId) => {
    const result = await session.sql(`SELECT id FROM user WHERE id=${userId};`).execute();
    const userIds = result.fetchAll();

    if (!userIds.length) {
        throw new UserNotFoundError('User not found!');
    }
};

const findNextPlayerOrder = async (session, gameId) => {
    const lastPlayerRes = await session
        .sql(
            `SELECT id, user_id FROM game_hand
            WHERE type="thrown" OR type="challenged" AND game_id=${gameId}
            ORDER BY id DESC
            LIMIT 1;`
        )
        .execute();

    const lastPlayer = lastPlayerRes.fetchOne();

    if (!lastPlayer) {
        return 1;
    }

    const lastPlayerOrderRes = await session
        .sql(
            `SELECT user_order FROM game_user_sequence
            WHERE game_id=${gameId} AND user_id=${lastPlayer[1]};`
        )
        .execute();

    const lastPlayerOrder = lastPlayerOrderRes.fetchOne()[0];
    return lastPlayerOrder === TOTAL_PLAYERS_IN_GAME ? 1 : lastPlayerOrder + 1;
};

const isNextPlayer = async (session, gameId, userId) => {
    const order = await findNextPlayerOrder(session, gameId);
    const nextPlayerRes = await session
        .sql(
            `SELECT * FROM game_user_sequence
            WHERE game_id=${gameId} AND user_id=${userId} AND user_order=${order}
            LIMIT 1;`
        )
        .execute();

    return !!nextPlayerRes.fetchOne();
};

const createGameUserSequence = async (session, gameId, userId, userOrder) => {
    await session
        .sql(
            `INSERT INTO game_user_sequence (game_id, user_id, user_order)
            VALUES (${gameId}, ${userId}, ${userOrder});`
        )
        .execute();
};

const getUserCards = async (session, gameId, userId) => {
    // find largest id from "current" game_hand and resolve foreign keys with joins
    // in order to get user's current cards
    const result = await session
        .sql(
            `SELECT card.id as id, card_shape.name as shape, card_symbol.name as symbol FROM card
            INNER JOIN card_symbol ON card.symbol_id=card_symbol.id
            INNER JOIN card_shape ON card.shape_id=card_shape.id
            WHERE card.id IN (
                SELECT card_id FROM game_hand_user_card
                WHERE game_hand_id IN (
                    SELECT max(id)
                    FROM game_hand
                    WHERE game_id=${gameId} AND user_id=${userId} AND type="current"
                )
            )
            ORDER BY shape;`
        )
        .execute();

    return result.fetchAll().map(([id, shape, symbol]) => ({ id, shape, symbol }));
};

const getLastThrownHandId = async (session, gameId) => {
    const result = await session
        .sql(`SELECT max(id) FROM game_hand WHERE game_id=${gameId} AND type="thrown";`)
        .execute();

    const lastThrown = result.fetchOne();

    if (!lastThrown) {
        throw new Error('No player has played yet, no declaration found');
    }

    return lastThrown[0];
};

const getLastDeclaration = async (session, gameId) => {
    const lastThrownId = await getLastThrownHandId(session, gameId);
    const saidCardsRes = await session
        .sql(`SELECT card_id FROM game_hand_card WHERE game_hand_id=${lastThrownId} AND type="said";`)
        .execute();

    const saidCards = saidCardsRes.fetchAll();
    const quantity = saidCards.length;

    if (!quantity) {
        return {
            lastDeclaration: {},
        };
    }

    const sampleCardId = saidCards[0][0];

    const shapeRes = await session
        .sql(
            `SELECT card_shape.name FROM card
            INNER JOIN card_shape ON card.shape_id=card_shape.id
            WHERE card.id=${sampleCardId};`
        )
        .execute();

    return {
        lastDeclaration: {
            quantity,
            shape: shapeRes.fetchOne()[0],
        },
    };
};

const getNextPlayer = async (session, gameId) => {
    const nextPlayerOrder = await findNextPlayerOrder(session, gameId);

    const nextPlayerRes = await session
        .sql(
            `SELECT g.user_id, user.name
            FROM game_user_sequence as g
            INNER JOIN user ON user.id=g.user_id
            WHERE g.game_id=${gameId} AND g.user_order=${nextPlayerOrder};`
        )
        .execute();

    const [id, name] = nextPlayerRes.fetchOne() || [];
    return { id, name };
};

const getPreviousPlayerId = async (session, gameId, userId) => {
    const userOrderRes = await session
        .sql(
            `SELECT user_order
            FROM game_user_sequence
            WHERE game_id=${gameId} AND user_id=${userId};`
        )
        .execute();

    const [userOrder] = userOrderRes.fetchOne();
    const previousPlayerOrder = userOrder === 1 ? TOTAL_PLAYERS_IN_GAME : userOrder - 1;

    const previousPlayerIdRes = await session
        .sql(
            `SELECT user_id
            FROM game_user_sequence
            WHERE game_id=${gameId} AND user_order=${previousPlayerOrder};`
        )
        .execute();

    return previousPlayerIdRes.fetchOne()[0];
};

const handleChallenge = async (session, gameId, userId, bluffCards) => {
    const userCards = await getUserCards(session, gameId, userId);

    const insertRes = await session
        .sql(
            `INSERT INTO game_hand (game_id, user_id, type)
            VALUES (${gameId}, ${userId}, "current");`
        )
        .execute();

    const gameHandId = insertRes.getAutoIncrementValue();
    const userCardIds = userCards.map(({ id }) => id).concat(bluffCards.map(([_, id]) => id));

    // insert new cards for user
    await session
        .sql(
            `INSERT INTO game_hand_user_card (game_hand_id, user_id, card_id)
            VALUES ${userCardIds.map(id => `(${gameHandId}, ${userId}, ${id})`).join(',')};`
        )
        .execute();
};

const isGameOver = async (session, gameId, userId) => {
    const { hasWinner, winner } = await gameHasWinner(session, gameId);

    if (hasWinner) {
        return { winner, over: true };
    }

    const previousPlayerId = await getPreviousPlayerId(session, gameId, userId);
    const previousPlayerCards = await getUserCards(session, gameId, previousPlayerId);

    // previous player has no cards => winner
    if (!previousPlayerCards.length) {
        // update winner for gameId
        await session.sql(`UPDATE game SET won_by_user_id=${previousPlayerId} WHERE id=${gameId};`).execute();

        // update score for winner
        await session
            .sql(
                `INSERT INTO scoreboard (user_id, score)
                VALUES (${previousPlayerId}, 1)
                ON DUPLICATE KEY UPDATE score = score + 1;`
            )
            .execute();
        return { winner: previousPlayerId, over: true };
    }

    return { over: false };
};

const gameHasWinner = async (session, gameId) => {
    const result = await session.sql(`SELECT won_by_user_id FROM game WHERE id=${gameId};`).execute();
    const game = result.fetchOne();

    if (!game) {
        return { hasWinner: false };
    }

    return { hasWinner: true, winner: game[0] };
};

mysql.getSession(CONFIG).then(
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

        app.get('/login', async (req, res) => {
            const { name } = req.query;

            if (!name) {
                handleError(res, 'name request param missing', 'GET /login?name=');
                return;
            }

            try {
                // insert new user to db
                const insertRes = await s.sql(`INSERT INTO user (name) VALUES ("${name}");`).execute();
                const userId = insertRes.getAutoIncrementValue();

                // check which games await for users (not full)
                const availableGamesRes = await s
                    .sql(
                        `SELECT game_id, COUNT(*) as count
                        FROM game_user_sequence
                        GROUP BY game_id
                        HAVING count < ${TOTAL_PLAYERS_IN_GAME};`
                    )
                    .execute();
                const availableGameIds = availableGamesRes.fetchAll().map(game => game[0]);

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
            } catch (error) {
                handleError(res, error, 'GET /login?name=');
            }
        });

        app.get('/new-game', async (req, res) => {
            const { userId } = req.query;

            if (!userId) {
                handleError(res, 'userId request param missing', 'GET /new-game?userId=');
                return;
            }

            try {
                await checkUserExistence(s, userId);

                // create new game in db
                const insertRes = await s
                    .sql(
                        `INSERT INTO game (created_by_user_id, creation_date)
                        VALUES (${userId}, "${new Date()
                            .toISOString()
                            // remove milliseconds
                            .slice(0, 19)
                            .replace('T', ' ')}");`
                    )
                    .execute();

                const gameId = insertRes.getAutoIncrementValue();
                await createGameUserSequence(s, gameId, userId, 1);

                res.send({
                    message:
                        `A new game was created successfully. Your game id is ${gameId}. ` +
                        'You need to remember it for the duration of your game. ' +
                        'Your sequence order is 1.',
                    gameId,
                });
            } catch (error) {
                if (error instanceof UserNotFoundError) {
                    handleError(
                        res,
                        `No user found with id=${userId}. You have to login first`,
                        'GET /login?name='
                    );
                    return;
                }

                handleError(res, error, 'GET /new-game?userId=');
            }
        });

        app.get('/join-game', async (req, res) => {
            const { userId, gameId } = req.query;

            if (!userId || !gameId) {
                handleError(res, 'userId or gameId request param missing', 'GET /join-game?userId=&gameId=');
                return;
            }

            try {
                await checkUserExistence(s, userId);

                // search for game
                const allGamesRes = await s.sql(`SELECT id FROM game WHERE id=${gameId};`).execute();
                const allGameIds = allGamesRes.fetchAll();

                if (!allGameIds.length) {
                    handleError(
                        res,
                        `Game with gameId=${gameId} doesn't exist. Please create a new game.`,
                        'GET /new-game?userId='
                    );
                    return;
                }

                // check if user is indeed in the game
                const userRes = await s
                    .sql(`SELECT * FROM game_user_sequence WHERE game_id=${gameId} AND user_id=${userId};`)
                    .execute();
                const userInGame = userRes.fetchOne();

                if (userInGame) {
                    handleError(res, `User with userId=${userId} is already in the game.`);
                    return;
                }

                // check if game can accept more players or is already full
                const usersRes = await s
                    .sql(
                        `SELECT game_id, COUNT(*) as count
                        FROM game_user_sequence
                        WHERE game_id=${gameId}
                        GROUP BY game_id
                        HAVING count < ${TOTAL_PLAYERS_IN_GAME};`
                    )
                    .execute();

                if (!usersRes.fetchAll().length) {
                    handleError(
                        res,
                        `Game with gameId=${gameId} is full. Please create a new game or join another one.`,
                        'GET /new-game?userId= , GET /join-game?userId=&gameId='
                    );
                    return;
                }

                // find existing users in game to determine new user's order/sequence
                const usersInGameRes = await s
                    .sql(
                        `SELECT user_id, user_order
                        FROM game_user_sequence
                        WHERE game_id=${gameId}
                        ORDER BY user_order;`
                    )
                    .execute();

                const usersInGame = usersInGameRes.fetchAll();
                const lastUser = usersInGame[usersInGame.length - 1];
                const userOrder = lastUser[1] + 1;

                await createGameUserSequence(s, gameId, userId, userOrder);

                if (usersInGame.length + 1 !== TOTAL_PLAYERS_IN_GAME) {
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

                // game is full => give out the cards
                const cardsRes = await s.sql('SELECT id FROM card;').execute();
                const shuffledCards = _.shuffle(cardsRes.fetchAll());

                const userIds = usersInGame.map(([id]) => id).concat(userId);

                const noCardsPerUser = Math.floor(shuffledCards.length / TOTAL_PLAYERS_IN_GAME);

                // structure like {1: [1,3,7,17,16], 2: [5,2,6,8,9]}
                const cardsPerUser = userIds.reduce((acc, userId) => {
                    // take the amount of cards
                    acc[userId] = _.take(shuffledCards, noCardsPerUser);

                    // and remove them from the list of cards
                    shuffledCards.splice(0, noCardsPerUser - 1);

                    return acc;
                }, {});

                await Promise.all(
                    userIds.map(async id => {
                        // create row with type="current"
                        const insertRes = await s
                            .sql(
                                `INSERT INTO game_hand (game_id, user_id, type)
                                VALUES (${gameId}, ${id}, "current");`
                            )
                            .execute();
                        const gameHandId = insertRes.getAutoIncrementValue();

                        return s
                            .sql(
                                `INSERT INTO game_hand_user_card (game_hand_id, user_id, card_id)
                                VALUES ${cardsPerUser[id]
                                    .map(([cardId]) => `(${gameHandId}, ${id}, ${cardId})`)
                                    .join(',')};`
                            )
                            .execute();
                    })
                );
                res.send({
                    message:
                        `You have successfully joined the game with gameId=${gameId}. ` +
                        `Your sequence order is ${userOrder}.`,
                    userId,
                    gameId,
                    userOrder,
                });
            } catch (error) {
                if (error instanceof UserNotFoundError) {
                    handleError(
                        res,
                        `No user found with id=${userId}. You have to login first`,
                        'GET /login?name='
                    );
                    return;
                }

                handleError(res, error, 'GET /join-game?userId=&gameId=');
            }
        });

        app.get('/my-cards', async (req, res) => {
            const { userId, gameId } = req.query;

            if (!userId || !gameId) {
                handleError(res, 'userId or gameId request param missing', 'GET /my-cards?userId=&gameId=');
                return;
            }

            try {
                const { over, winner } = await isGameOver(s, gameId, userId);

                if (over) {
                    res.send({
                        result: `Game is over. Winner is user with id=${winner}`,
                    });
                    return;
                }

                const myCards = await getUserCards(s, gameId, userId);

                // get all deck cards
                const allCardsRes = await s
                    .sql(
                        `SELECT card.id as id, card_shape.name as shape, card_symbol.name as symbol
                        FROM card
                        INNER JOIN card_symbol ON card.symbol_id=card_symbol.id
                        INNER JOIN card_shape ON card.shape_id=card_shape.id
                        ORDER BY symbol;`
                    )
                    .execute();

                const allCards = allCardsRes.fetchAll().map(([id, shape, symbol]) => ({ id, shape, symbol }));

                res.send({
                    myCards,
                    userId,
                    gameId,
                    allCards,
                });
            } catch (error) {
                handleError(res, error, 'GET /my-cards?userId=&gameId=');
            }
        });

        app.get('/throw', async (req, res) => {
            const { userId, gameId, actual, shape } = req.query.userId;
            const quantityStr = req.query.quantity;

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

            try {
                const shapesRes = await s.sql(`SELECT id FROM card_shape WHERE name="${shape}";`).execute();
                const cardShapes = shapesRes.fetchAll();

                if (!cardShapes.length) {
                    handleError(
                        res,
                        "provided shape doesn't exist",
                        'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                    );
                    return;
                }

                const { over, winner } = await isGameOver(s, gameId, userId);

                if (over) {
                    res.send({
                        result: `Game is over. Winner is user with id=${winner}`,
                    });
                    return;
                }

                const canPlay = await isNextPlayer(s, gameId, userId);
                if (!canPlay) {
                    handleError(
                        res,
                        'you are not the next player',
                        'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                    );
                    return;
                }

                // it's this player's order
                const myCards = await getUserCards(s, gameId, userId);

                // make sure provided card ids are in the player's hands
                if (cardsIds.every(id => myCards.find(c => c.id === id))) {
                    handleError(
                        res,
                        'some of the provided cards ids do not belong to you',
                        'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                    );
                    return;
                }

                const insertRes = await s
                    .sql(
                        `INSERT INTO game_hand (game_id, user_id, type)
                        VALUES (${gameId}, ${userId}, "thrown");`
                    )
                    .execute();
                const gameHandId = insertRes.getAutoIncrementValue();
                const requestedShapeId = cardShapes[0];

                // find random ids for provided shape and limit by quantity
                const cardsRes = await s
                    .sql(`SELECT id FROM card WHERE shape_id=${requestedShapeId} LIMIT ${quantity};`)
                    .execute();

                const quantityRange = _.range(0, quantity);
                const randomShapeCardIds = cardsRes.fetchAll().map(([id]) => id);
                const actualRows = quantityRange.map(i => `(${gameHandId}, ${cardsIds[i]}, "actual")`);
                const saidRows = quantityRange.map(i => `(${gameHandId}, ${randomShapeCardIds[i]}, "said")`);

                // insert many into game_hand_card
                await s
                    .sql(
                        `INSERT INTO game_hand_card (game_hand_id, card_id, type)
                        VALUES ${[actualRows.join(','), saidRows.join(',')].join(',')};`
                    )
                    .execute();

                // find after throw which cards are left in player's hand
                const updatedUserCards = myCards.filter(c => !cardsIds.includes(c.id.toString()));

                // insert new row for type=current
                const currentInsertRes = await s
                    .sql(
                        `INSERT INTO game_hand (game_id, user_id, type)
                        VALUES (${gameId}, ${userId}, "current");`
                    )
                    .execute();

                const currentGameHandId = currentInsertRes.getAutoIncrementValue();
                const cardRows = updatedUserCards.map(c => `(${currentGameHandId}, ${userId}, ${c.id})`);

                if (!cardRows.length) {
                    res.send({
                        message: 'Your turn was successfull',
                        myCards: updatedUserCards,
                        gameId,
                        userId,
                    });
                    return;
                }

                // insert remaining user cards for game_hand_id
                await s
                    .sql(
                        `INSERT INTO game_hand_user_card (game_hand_id, user_id, card_id)
                        VALUES ${cardRows.join(',')};`
                    )
                    .execute();

                res.send({
                    message: 'Your turn was successfull',
                    myCards: updatedUserCards,
                    gameId,
                    userId,
                });
            } catch (error) {
                handleError(res, error, 'GET /throw?userId=&gameId=&quantity=&shape=&actual=');
            }
        });

        app.get('/last-declaration', async (req, res) => {
            const { gameId } = req.query;

            if (!gameId) {
                handleError(res, 'gameId request param missing', 'GET /last-declaration?gameId=');
                return;
            }

            try {
                const { over, winner } = await isGameOver(s, gameId);

                if (over) {
                    res.send({
                        result: `Game is over. Winner is user with id=${winner}`,
                    });
                    return;
                }

                const result = await getLastDeclaration(s, gameId);
                res.send(result);
            } catch (error) {
                handleError(res, error, 'GET /last-declaration?gameId=');
            }
        });

        app.get('/challenge', async (req, res) => {
            const { userId, gameId } = req.query;

            if (!userId || !gameId) {
                handleError(res, 'userId or gameId request param missing', 'GET /challenge?userId=&gameId=');
                return;
            }

            const { over, winner } = await isGameOver(s, gameId, userId);

            if (over) {
                res.send({
                    result: `Game is over. Winner is user with id=${winner}`,
                });
                return;
            }

            const { lastDeclaration } = await getLastDeclaration(s, gameId);
            if (_.isEmpty(lastDeclaration)) {
                handleError(
                    res,
                    'Cannot challenge. No player has played yet',
                    'GET /challenge?userId=&gameId='
                );
                return;
            }

            const canPlay = await isNextPlayer(s, gameId, userId);
            if (!canPlay) {
                handleError(res, 'you are not the next player', 'GET /challenge?userId=&gameId=');
                return;
            }

            await s
                .sql(
                    `INSERT INTO game_hand (game_id, user_id, type)
                    VALUES (${gameId}, ${userId}, "challenged");`
                )
                .execute();

            const lastThrownId = await getLastThrownHandId(s, gameId);
            const actualCardsRes = await s
                .sql(
                    `SELECT name, card_id FROM game_hand_card
                    INNER JOIN card ON card.id=card_id
                    INNER JOIN card_shape on card_shape.id=shape_id
                    WHERE game_hand_id=${lastThrownId} AND type="actual";`
                )
                .execute();

            const {
                lastDeclaration: { shape },
            } = await getLastDeclaration(s, gameId);

            const actualCards = actualCardsRes.fetchAll();
            const allCardsSame = actualCards.every(([name]) => name === shape);

            if (!allCardsSame) {
                // previous player takes the bluff cards
                const previousPlayerId = await getPreviousPlayerId(s, gameId, userId);
                await handleChallenge(s, gameId, previousPlayerId, actualCards);

                res.send({
                    gameId,
                    userId,
                    result: `Your bluff was successfull! Last thrown cards are in the deck of user with id=${previousPlayerId}.`,
                });
                return;
            }

            await handleChallenge(s, gameId, userId, actualCards);
            res.send({
                gameId,
                userId,
                result: 'Your bluff was unsuccessfull! Last thrown cards are in your deck.',
            });
        });

        app.get('/status', async (req, res) => {
            const { gameId } = req.query;

            if (!gameId) {
                handleError(res, 'gameId request param missing', 'GET /status?gameId=');
                return;
            }

            try {
                const gameRes = await s
                    .sql(
                        `SELECT game.created_by_user_id, u1.name, game.creation_date, game.won_by_user_id, u2.name FROM game
                        INNER JOIN user as u1 ON game.created_by_user_id=u1.id
                        LEFT JOIN user as u2 ON game.won_by_user_id=u2.id
                        WHERE game.id=${gameId};`
                    )
                    .execute();
                const game = gameRes.fetchOne();

                if (!game) {
                    handleError(res, `No game with id=${gameId} found`);
                    return;
                }

                const playersRes = await s
                    .sql(
                        `SELECT g.user_id, user.name, g.user_order
                        FROM game_user_sequence as g
                        INNER JOIN user ON g.user_id=user.id
                        WHERE g.game_id=${gameId}
                        ORDER BY g.user_order;`
                    )
                    .execute();
                const players = playersRes.fetchAll();

                const lastDeclaration = await getLastDeclaration(s, gameId);
                const nextPlayer = await getNextPlayer(s, gameId);
                const [createdByUserId, createdByUsername, creationDate, winnerId, winnerName] = game;

                res.send({
                    gameId,
                    game: {
                        winner: winnerName ? `${winnerName} (id: ${winnerId})` : '-',
                        ongoing: !_.isNumber(winnerId),
                        creationDate,
                        createdBy: `${createdByUsername} (id: ${createdByUserId})`,
                        players: players.map(([id, name, order]) => ({
                            id,
                            name,
                            order,
                        })),
                        // spread operator
                        ...lastDeclaration,
                        nextPlayer,
                    },
                });
            } catch (error) {
                handleError(res, error, 'GET /last-declaration?gameId=');
            }
        });

        app.get('/score', async (req, res) => {
            const { userId } = req.query;

            if (!userId) {
                // show all scores
                const scoreboardRes = await s
                    .sql(
                        `SELECT s.id, s.user_id, user.name, s.score
                        FROM scoreboard as s
                        INNER JOIN user ON user.id=s.user_id;`
                    )
                    .execute();
                const scoreboard = scoreboardRes.fetchAll();

                res.send({
                    scoreboard: scoreboard.map(([id, user_id, name, score]) => ({
                        id,
                        userId: user_id,
                        userName: name,
                        score,
                    })),
                });
                return;
            }

            // show single user score
            const result = await s
                .sql(
                    `SELECT s.id, s.user_id, user.name, s.score
                    FROM scoreboard as s
                    INNER JOIN user ON user.id=s.user_id
                    WHERE s.user_id=${userId};`
                )
                .execute();
            const scoreboard = result.fetchOne();

            res.send({
                scoreboard: scoreboard
                    ? {
                          id: scoreboard[0],
                          userId: scoreboard[1],
                          userName: scoreboard[2],
                          score: scoreboard[3],
                      }
                    : {},
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
