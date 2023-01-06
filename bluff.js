'use strict';
const express = require('express');
const mysql = require('mysql');
const _ = require('lodash');
const app = express();

const CARD_SYMBOLS = ['clubs (♣)', 'diamonds (♦)', 'hearts (♥)', 'spades (♠)'];
// range [2, 10]
const CARD_SHAPES = _.range(2, 11, 1).concat(['J', 'Q', 'K', 'A']);
const PORT = 30000;
const TOTAL_PLAYERS_IN_GAME = 2;

const queryPromise = query => {
    return new Promise((resolve, reject) => {
        connection.query(query, (error, res) => {
            if (error) {
                reject(error);
                return;
            }

            resolve(res);
        });
    });
};

const connection = mysql.createConnection({
    user: 'root',
});

const handleError = (res, error, endpoint) => {
    console.error(error);
    const result = { error: error instanceof Error ? error.message : error };

    if (endpoint) {
        result.endpoint = endpoint;
    }

    res.json(result);
};

class UserNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UserNotFoundError';
    }
}

class GameNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GameNotFoundError';
    }
}

const checkUserExistence = async userId => {
    const users = await queryPromise(`SELECT id FROM user WHERE id=${userId};`);

    if (!users.length) {
        throw new UserNotFoundError('User not found!');
    }
};

const checkGameExistence = async gameId => {
    const games = await queryPromise(`SELECT * FROM game WHERE id=${gameId};`);

    if (!games.length) {
        throw new GameNotFoundError('Game not found!');
    }
};

const findNextPlayerOrder = async gameId => {
    const [lastPlayer] = await queryPromise(
        `SELECT id, user_id FROM game_hand
        WHERE type="thrown" OR type="challenged" AND game_id=${gameId}
        ORDER BY id DESC
        LIMIT 1;`
    );

    if (!lastPlayer) {
        return 1;
    }

    const lastPlayerOrderRes = await queryPromise(
        `SELECT user_order FROM game_user_sequence
        WHERE game_id=${gameId} AND user_id=${lastPlayer.user_id};`
    );

    const lastPlayerOrder = lastPlayerOrderRes[0].user_order;
    return lastPlayerOrder === TOTAL_PLAYERS_IN_GAME ? 1 : lastPlayerOrder + 1;
};

const isNextPlayer = async (gameId, userId) => {
    const order = await findNextPlayerOrder(gameId);
    const nextPlayerRes = await queryPromise(
        `SELECT * FROM game_user_sequence
        WHERE game_id=${gameId} AND user_id=${userId} AND user_order=${order}
        LIMIT 1;`
    );

    return !!nextPlayerRes[0];
};

const createGameUserSequence = async (gameId, userId, userOrder) => {
    await queryPromise(
        `INSERT INTO game_user_sequence (game_id, user_id, user_order)
        VALUES (${gameId}, ${userId}, ${userOrder});`
    );
};

const getUserCards = (gameId, userId) => {
    // find largest id from "current" game_hand and resolve foreign keys with joins
    // in order to get user's current cards
    return queryPromise(
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
    );
};

const getLastThrownHandId = async gameId => {
    const [lastThrown] = await queryPromise(
        `SELECT max(id) as id FROM game_hand WHERE game_id=${gameId} AND type="thrown";`
    );

    if (!lastThrown.id) {
        throw new Error('No player has played yet, no declaration found');
    }

    return lastThrown.id;
};

const getLastDeclaration = async gameId => {
    try {
        const lastThrownId = await getLastThrownHandId(gameId);
        const saidCards = await queryPromise(
            `SELECT card_id FROM game_hand_card WHERE game_hand_id=${lastThrownId} AND type="said";`
        );

        const quantity = saidCards.length;

        if (!quantity) {
            return {
                lastDeclaration: {},
            };
        }

        const sampleCardId = saidCards[0].card_id;

        const shapeRes = await queryPromise(
            `SELECT card_shape.name FROM card
            INNER JOIN card_shape ON card.shape_id=card_shape.id
            WHERE card.id=${sampleCardId};`
        );

        return {
            lastDeclaration: {
                quantity,
                shape: shapeRes[0].name,
            },
        };
    } catch (_e) {
        return {
            lastDeclaration: {},
        };
    }
};

const getNextPlayer = async gameId => {
    const nextPlayerOrder = await findNextPlayerOrder(gameId);

    const nextPlayerRes = await queryPromise(
        `SELECT g.user_id, user.name
        FROM game_user_sequence as g
        INNER JOIN user ON user.id=g.user_id
        WHERE g.game_id=${gameId} AND g.user_order=${nextPlayerOrder};`
    );

    const { user_id, name } = nextPlayerRes[0] || {};
    return { id: user_id, name };
};

const getPreviousPlayerId = async (gameId, userId) => {
    const userOrderRes = await queryPromise(
        `SELECT user_order
        FROM game_user_sequence
        WHERE game_id=${gameId} AND user_id=${userId};`
    );

    if (!userOrderRes.length) {
        throw new Error('game or user not found!');
    }

    const { user_order } = userOrderRes[0];
    const previousPlayerOrder = user_order === 1 ? TOTAL_PLAYERS_IN_GAME : user_order - 1;

    const previousPlayerIdRes = await queryPromise(
        `SELECT user_id
        FROM game_user_sequence
        WHERE game_id=${gameId} AND user_order=${previousPlayerOrder};`
    );

    return previousPlayerIdRes[0].user_id;
};

const handleChallenge = async (gameId, userId, bluffCards) => {
    const userCards = await getUserCards(gameId, userId);

    const insertRes = await queryPromise(
        `INSERT INTO game_hand (game_id, user_id, type)
        VALUES (${gameId}, ${userId}, "current");`
    );

    const gameHandId = insertRes.insertId;
    const userCardIds = userCards.map(({ id }) => id).concat(bluffCards.map(({ card_id }) => card_id));

    // insert new cards for user
    await queryPromise(
        `INSERT INTO game_hand_user_card (game_hand_id, user_id, card_id)
        VALUES ${userCardIds.map(id => `(${gameHandId}, ${userId}, ${id})`).join(',')};`
    );
};

const isGameOver = async gameId => {
    const { hasWinner, winner } = await gameHasWinner(gameId);

    if (hasWinner) {
        return { winner, over: true };
    }

    return { over: false };
};

const setWinnerAndUpdateScore = async (gameId, winnerId) => {
    // update winner for gameId
    await queryPromise(`UPDATE game SET won_by_user_id=${winnerId} WHERE id=${gameId};`);

    // update score for winner
    await queryPromise(
        `INSERT INTO scoreboard (user_id, score)
            VALUES (${winnerId}, 1)
            ON DUPLICATE KEY UPDATE score = score + 1;`
    );
};

const gameHasWinner = async gameId => {
    const [game] = await queryPromise(`SELECT won_by_user_id FROM game WHERE id=${gameId};`);

    if (!game || !Number.isInteger(game.won_by_user_id)) {
        return { hasWinner: false };
    }

    return { hasWinner: true, winner: game.won_by_user_id };
};

const initializeDB = async () => {
    await queryPromise('CREATE DATABASE IF NOT EXISTS bluff;');
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.card_shape (
            id INT NOT NULL AUTO_INCREMENT,
            name VARCHAR(45) NOT NULL,
            PRIMARY KEY (id));`);
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.card_symbol (
            id INT NOT NULL AUTO_INCREMENT,
            name VARCHAR(45) NOT NULL,
            PRIMARY KEY (id));`);
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.user (
            id INT NOT NULL AUTO_INCREMENT,
            name VARCHAR(45) NOT NULL,
            PRIMARY KEY (id));`);
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.card (
            id INT NOT NULL AUTO_INCREMENT,
            symbol_id INT NOT NULL,
            shape_id INT NOT NULL,
            PRIMARY KEY (id),
            INDEX fk_card_symbol_id_idx (symbol_id ASC),
            INDEX fk_card_shape_id_idx (shape_id ASC),
            CONSTRAINT fk_card_symbol_id
                FOREIGN KEY (symbol_id)
                REFERENCES bluff.card_symbol (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION,
            CONSTRAINT fk_card_shape_id
                FOREIGN KEY (shape_id)
                REFERENCES bluff.card_shape (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION);`);
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.game (
            id INT NOT NULL AUTO_INCREMENT,
            created_by_user_id INT NOT NULL,
            creation_date DATETIME NOT NULL,
            won_by_user_id INT NULL,
            PRIMARY KEY (id),
            INDEX fk_created_by_user_id_idx (created_by_user_id ASC),
            INDEX fk_won_by_user_id_idx (won_by_user_id ASC),
            CONSTRAINT fk_created_by_user_id
                FOREIGN KEY (created_by_user_id)
                REFERENCES bluff.user (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION,
            CONSTRAINT fk_won_by_user_id
                FOREIGN KEY (won_by_user_id)
                REFERENCES bluff.user (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION);`);
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.game_user_sequence (
            id INT NOT NULL AUTO_INCREMENT,
            game_id INT NOT NULL,
            user_id INT NOT NULL,
            user_order INT NOT NULL,
            PRIMARY KEY (id),
            INDEX fk_game_id_idx (game_id ASC),
            INDEX fk_user_id_idx (user_id ASC),
            UNIQUE INDEX game_user_order (user_order ASC, user_id ASC, game_id ASC),
            CONSTRAINT fk_game_id
                FOREIGN KEY (game_id)
                REFERENCES bluff.game (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION,
            CONSTRAINT fk_user_id
                FOREIGN KEY (user_id)
                REFERENCES bluff.user (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION);`);
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.game_hand (
            id INT NOT NULL AUTO_INCREMENT,
            game_id INT NOT NULL,
            user_id INT NOT NULL,
            type VARCHAR(45) NOT NULL,
            PRIMARY KEY (id),
            INDEX fk_game_id_idx (game_id ASC) ,
            INDEX fk_user_id_idx (user_id ASC) ,
            CONSTRAINT fk_game_id_2
                FOREIGN KEY (game_id)
                REFERENCES bluff.game (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION,
            CONSTRAINT fk_user_id_2
                FOREIGN KEY (user_id)
                REFERENCES bluff.user (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION);`);
    await queryPromise(`
        ALTER TABLE bluff.game_hand
        MODIFY COLUMN type enum("current", "thrown", "challenged");`);
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.game_hand_card (
            id INT NOT NULL AUTO_INCREMENT,
            game_hand_id INT NOT NULL,
            card_id INT NOT NULL,
            type VARCHAR(45) NOT NULL,
            PRIMARY KEY (id),
            INDEX fk_game_hand_id_idx (game_hand_id ASC) ,
            INDEX fk_card_id_idx (card_id ASC) ,
            CONSTRAINT fk_game_hand_id
                FOREIGN KEY (game_hand_id)
                REFERENCES bluff.game_hand (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION,
            CONSTRAINT fk_card_id
                FOREIGN KEY (card_id)
                REFERENCES bluff.card (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION);`);
    await queryPromise(`
        ALTER TABLE bluff.game_hand_card
        MODIFY COLUMN type enum("said", "actual");`);
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.game_hand_user_card (
            id INT NOT NULL AUTO_INCREMENT,
            game_hand_id INT NOT NULL,
            user_id INT NOT NULL,
            card_id INT NOT NULL,
            PRIMARY KEY (id),
            UNIQUE INDEX id_UNIQUE (id ASC) ,
            UNIQUE INDEX game_hand_user_card (card_id ASC, user_id ASC, game_hand_id ASC) ,
            INDEX fk_game_hand_id_2_idx (game_hand_id ASC) ,
            INDEX fk_user_id_3_idx (user_id ASC) ,
            CONSTRAINT fk_game_hand_id_2
                FOREIGN KEY (game_hand_id)
                REFERENCES bluff.game_hand (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION,
            CONSTRAINT fk_user_id_3
                FOREIGN KEY (user_id)
                REFERENCES bluff.user (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION,
            CONSTRAINT fk_card_id_2
                FOREIGN KEY (card_id)
                REFERENCES bluff.card (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION);`);
    await queryPromise(`
        CREATE TABLE IF NOT EXISTS bluff.scoreboard (
            id INT NOT NULL AUTO_INCREMENT,
            user_id INT NOT NULL,
            score INT NOT NULL,
            PRIMARY KEY (id),
            UNIQUE INDEX id_UNIQUE (id ASC) ,
            UNIQUE INDEX user_id_UNIQUE (user_id ASC) ,
            INDEX fk_user_id_4_idx (user_id ASC) ,
            CONSTRAINT fk_user_id_4
                FOREIGN KEY (user_id)
                REFERENCES bluff.user (id)
                ON DELETE NO ACTION
                ON UPDATE NO ACTION);`);
    // insert symbol values if empty
    const symbols = await queryPromise('SELECT * FROM bluff.card_symbol;');
    if (!symbols.length) {
        await queryPromise(`
            INSERT INTO bluff.card_symbol (id, name)
            VALUES ${CARD_SYMBOLS.map((symbol, idx) => `(${idx + 1}, "${symbol}")`).join(',')};
        `);
    }

    // insert shape values if empty
    const shapes = await queryPromise('SELECT * FROM bluff.card_shape;');
    if (!shapes.length) {
        await queryPromise(`
            INSERT INTO bluff.card_shape (id, name)
            VALUES ${CARD_SHAPES.map((shape, idx) => `(${idx + 1}, "${shape}")`).join(',')};
        `);
    }

    // insert card values based on shape/symbol ids if empty
    // flatten nested arrays to 1d array
    const cards = await queryPromise('SELECT * FROM bluff.card;');
    if (!cards.length) {
        await queryPromise(`
            INSERT INTO bluff.card (symbol_id, shape_id)
            VALUES ${_.flatten(
                CARD_SYMBOLS.map((_, symbolId) =>
                    CARD_SHAPES.map((_, shapeId) => `(${symbolId + 1}, ${shapeId + 1})`).join(',')
                )
            )};
        `);
    }
};

connection.connect(async error => {
    if (error) {
        console.error(error);
        return;
    }

    // initialize schema and tables
    await initializeDB();
    // use bluff db that was created before
    await queryPromise('USE bluff');

    app.set('json spaces', 2);

    app.get('/rules', (_req, res) => {
        res.json({
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
            const insertRes = await queryPromise(`INSERT INTO user (name) VALUES ("${name}");`);
            const userId = insertRes.insertId;

            // check which games await for users (not full)
            const availableGames = await queryPromise(
                `SELECT game_id, COUNT(*) as count
                FROM game_user_sequence
                GROUP BY game_id
                HAVING count < ${TOTAL_PLAYERS_IN_GAME};`
            );
            const availableGameIds = availableGames.map(({ game_id }) => game_id);

            res.json({
                message:
                    `You logged in successfully. Your unique userId is ${userId}. ` +
                    'You need to remember it for the duration of your game. ' +
                    `${
                        availableGames.length
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
            await checkUserExistence(userId);

            // create new game in db
            const insertRes = await queryPromise(
                `INSERT INTO game (created_by_user_id, creation_date)
                VALUES (${userId}, "${new Date()
                    .toISOString()
                    // remove milliseconds
                    .slice(0, 19)
                    .replace('T', ' ')}");`
            );

            const gameId = insertRes.insertId;
            await createGameUserSequence(gameId, userId, 1);

            res.json({
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
            await checkGameExistence(gameId);
            await checkUserExistence(userId);

            // check if user is indeed in the game
            const userRes = await queryPromise(
                `SELECT * FROM game_user_sequence WHERE game_id=${gameId} AND user_id=${userId};`
            );
            const userInGame = userRes[0];

            if (userInGame) {
                handleError(res, `User with userId=${userId} is already in the game.`);
                return;
            }

            // check if game can accept more players or is already full
            const usersRes = await queryPromise(
                `SELECT game_id, COUNT(*) as count
                FROM game_user_sequence
                WHERE game_id=${gameId}
                GROUP BY game_id
                HAVING count < ${TOTAL_PLAYERS_IN_GAME};`
            );

            if (!usersRes.length) {
                handleError(
                    res,
                    `Game with gameId=${gameId} is full. Please create a new game or join another one.`,
                    'GET /new-game?userId= , GET /join-game?userId=&gameId='
                );
                return;
            }

            // find existing users in game to determine new user's order/sequence
            const usersInGame = await queryPromise(
                `SELECT user_id, user_order
                FROM game_user_sequence
                WHERE game_id=${gameId}
                ORDER BY user_order;`
            );

            const lastUser = usersInGame[usersInGame.length - 1];
            const userOrder = lastUser.user_order + 1;
            await createGameUserSequence(gameId, userId, userOrder);

            if (usersInGame.length + 1 !== TOTAL_PLAYERS_IN_GAME) {
                res.json({
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
            const cards = await queryPromise('SELECT id FROM card;');
            // shuffle cards
            const shuffledCards = _.shuffle(cards.map(({ id }) => id));
            // calculate how many cards each player should get
            const noCardsPerUser = Math.floor(shuffledCards.length / TOTAL_PLAYERS_IN_GAME);
            const userIds = usersInGame.map(({ user_id }) => user_id).concat(userId);

            // structure like {1: [1,3,7,17,16], 2: [5,2,6,8,9]}
            const cardsPerUser = userIds.reduce((acc, userId) => {
                // take the amount of cards
                acc[userId] = _.take(shuffledCards, noCardsPerUser);

                // and remove them from the list of cards
                shuffledCards.splice(0, noCardsPerUser);

                return acc;
            }, {});

            await Promise.all(
                userIds.map(async id => {
                    // create row with type="current"
                    const insertRes = await queryPromise(
                        `INSERT INTO game_hand (game_id, user_id, type)
                        VALUES (${gameId}, ${id}, "current");`
                    );
                    const gameHandId = insertRes.insertId;

                    return queryPromise(
                        `INSERT INTO game_hand_user_card (game_hand_id, user_id, card_id)
                        VALUES ${cardsPerUser[id]
                            .map(cardId => `(${gameHandId}, ${id}, ${cardId})`)
                            .join(',')};`
                    );
                })
            );
            res.json({
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

            if (error instanceof GameNotFoundError) {
                handleError(
                    res,
                    `Game with gameId=${gameId} doesn't exist. Please create a new game.`,
                    'GET /new-game?userId='
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
            await checkGameExistence(gameId);
            await checkUserExistence(userId);

            const { over, winner } = await isGameOver(gameId);

            if (over) {
                res.json({
                    result: `Game is over. Winner is user with id=${winner}`,
                });
                return;
            }

            const myCards = await getUserCards(gameId, userId);

            // get all deck cards
            const allCards = await queryPromise(
                `SELECT card.id as id, card_shape.name as shape, card_symbol.name as symbol
                FROM card
                INNER JOIN card_symbol ON card.symbol_id=card_symbol.id
                INNER JOIN card_shape ON card.shape_id=card_shape.id
                ORDER BY symbol;`
            );

            res.json({
                myCards,
                userId,
                gameId,
                allCards,
            });
        } catch (error) {
            if (error instanceof GameNotFoundError) {
                handleError(res, `Game with id=${gameId} not found`, 'GET /my-cards?userId=&gameId=');
                return;
            }
            if (error instanceof UserNotFoundError) {
                handleError(
                    res,
                    `No user found with id=${userId}. You have to login first`,
                    'GET /my-cards?userId=&gameId='
                );
            }
            handleError(res, error, 'GET /my-cards?userId=&gameId=');
        }
    });

    app.get('/throw', async (req, res) => {
        const { userId, gameId, actual, shape } = req.query;
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
            await checkGameExistence(gameId);
            await checkUserExistence(userId);

            const cardShapes = await queryPromise(`SELECT id FROM card_shape WHERE name="${shape}";`);

            if (!cardShapes.length) {
                handleError(
                    res,
                    "provided shape doesn't exist",
                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                );
                return;
            }

            const { over, winner } = await isGameOver(gameId);

            if (over) {
                res.json({ result: `Game is over. Winner is user with id=${winner}` });
                return;
            }

            const canPlay = await isNextPlayer(gameId, userId);
            if (!canPlay) {
                handleError(
                    res,
                    'you are not the next player',
                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                );
                return;
            }

            // it's this player's order
            const myCards = await getUserCards(gameId, userId);
            const myCardIds = myCards.map(c => c.id.toString());

            // make sure provided card ids are in the player's hands
            if (!cardsIds.every(id => myCardIds.includes(id))) {
                handleError(
                    res,
                    'some of the provided cards ids do not belong to you',
                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                );
                return;
            }

            // check before if previous player has won
            const previousPlayerId = await getPreviousPlayerId(gameId, userId);
            const previousPlayerCards = await getUserCards(gameId, previousPlayerId);

            if (!previousPlayerCards.length) {
                await setWinnerAndUpdateScore(gameId, previousPlayerId);

                res.json({
                    result: `Game is over. Winner is user with id=${previousPlayerId}`,
                });
                return;
            }

            const insertRes = await queryPromise(
                `INSERT INTO game_hand (game_id, user_id, type)
                VALUES (${gameId}, ${userId}, "thrown");`
            );
            const gameHandId = insertRes.insertId;
            const requestedShapeId = cardShapes[0].id;

            // find random ids for provided shape and limit by quantity
            const cardsRes = await queryPromise(
                `SELECT id FROM card WHERE shape_id=${requestedShapeId} LIMIT ${quantity};`
            );

            const quantityRange = _.range(0, quantity);
            const randomShapeCardIds = cardsRes.map(({ id }) => id);
            const actualRows = quantityRange.map(i => `(${gameHandId}, ${cardsIds[i]}, "actual")`);
            const saidRows = quantityRange.map(i => `(${gameHandId}, ${randomShapeCardIds[i]}, "said")`);

            // insert many into game_hand_card
            await queryPromise(
                `INSERT INTO game_hand_card (game_hand_id, card_id, type)
                VALUES ${[actualRows.join(','), saidRows.join(',')].join(',')};`
            );

            // find after throw which cards are left in player's hand
            const updatedUserCards = myCards.filter(c => !cardsIds.includes(c.id.toString()));

            // insert new row for type=current
            const currentInsertRes = await queryPromise(
                `INSERT INTO game_hand (game_id, user_id, type)
                VALUES (${gameId}, ${userId}, "current");`
            );

            const currentGameHandId = currentInsertRes.insertId;
            const cardRows = updatedUserCards.map(c => `(${currentGameHandId}, ${userId}, ${c.id})`);

            if (!cardRows.length) {
                res.json({
                    message: 'Your turn was successfull',
                    myCards: updatedUserCards,
                    gameId,
                    userId,
                });
                return;
            }

            // insert remaining user cards for game_hand_id
            await queryPromise(
                `INSERT INTO game_hand_user_card (game_hand_id, user_id, card_id)
                VALUES ${cardRows.join(',')};`
            );

            res.json({
                message: 'Your turn was successfull',
                myCards: updatedUserCards,
                gameId,
                userId,
            });
        } catch (error) {
            if (error instanceof GameNotFoundError) {
                handleError(
                    res,
                    `Game with id=${gameId} not found`,
                    'GET /throw?userId=&gameId=&quantity=&shape=&actual='
                );
                return;
            }
            if (error instanceof UserNotFoundError) {
                handleError(
                    res,
                    `No user found with id=${userId}. You have to login first`,
                    'GET /login?name='
                );
            }

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
            await checkGameExistence(gameId);

            const { over, winner } = await isGameOver(gameId);

            if (over) {
                res.json({ result: `Game is over. Winner is user with id=${winner}` });
                return;
            }

            const result = await getLastDeclaration(gameId);
            res.json(result);
        } catch (error) {
            if (error instanceof GameNotFoundError) {
                handleError(res, `Game with id=${gameId} not found`, 'GET /last-declaration?gameId=');
                return;
            }

            handleError(res, error, 'GET /last-declaration?gameId=');
        }
    });

    app.get('/challenge', async (req, res) => {
        const { userId, gameId } = req.query;

        if (!userId || !gameId) {
            handleError(res, 'userId or gameId request param missing', 'GET /challenge?userId=&gameId=');
            return;
        }

        try {
            await checkGameExistence(gameId);
            await checkUserExistence(userId);

            const { over, winner } = await isGameOver(gameId);

            if (over) {
                res.json({
                    result: `Game is over. Winner is user with id=${winner}`,
                });
                return;
            }

            const { lastDeclaration } = await getLastDeclaration(gameId);
            if (_.isEmpty(lastDeclaration)) {
                handleError(
                    res,
                    'Cannot challenge. No player has played yet',
                    'GET /challenge?userId=&gameId='
                );
                return;
            }

            const canPlay = await isNextPlayer(gameId, userId);
            if (!canPlay) {
                handleError(res, 'you are not the next player', 'GET /challenge?userId=&gameId=');
                return;
            }

            await queryPromise(
                `INSERT INTO game_hand (game_id, user_id, type)
                VALUES (${gameId}, ${userId}, "challenged");`
            );

            const lastThrownId = await getLastThrownHandId(gameId);
            const actualCards = await queryPromise(
                `SELECT name, card_id FROM game_hand_card
                INNER JOIN card ON card.id=card_id
                INNER JOIN card_shape on card_shape.id=shape_id
                WHERE game_hand_id=${lastThrownId} AND type="actual";`
            );

            const {
                lastDeclaration: { shape },
            } = await getLastDeclaration(gameId);

            const allCardsSame = actualCards.every(({ name }) => name === shape);
            const previousPlayerId = await getPreviousPlayerId(gameId, userId);

            if (!allCardsSame) {
                // previous player takes the bluff cards
                await handleChallenge(gameId, previousPlayerId, actualCards);

                res.json({
                    gameId,
                    userId,
                    result: `Your bluff was successfull! Last thrown cards are in the deck of user with id=${previousPlayerId}.`,
                });
                return;
            }

            await handleChallenge(gameId, userId, actualCards);

            // check before if previous player has won
            const previousPlayerCards = await getUserCards(gameId, previousPlayerId);

            if (!previousPlayerCards.length) {
                await setWinnerAndUpdateScore(gameId, previousPlayerId);

                res.json({
                    result: `Your bluff was unsuccessfull! Last thrown cards are in your deck. Game is over. Winner is user with id=${previousPlayerId}`,
                });
                return;
            }

            res.json({
                gameId,
                userId,
                result: 'Your bluff was unsuccessfull! Last thrown cards are in your deck.',
            });
        } catch (error) {
            if (error instanceof GameNotFoundError) {
                handleError(res, `Game with id=${gameId} not found`, 'GET /challenge?userId=&gameId=');
                return;
            }
            if (error instanceof UserNotFoundError) {
                handleError(
                    res,
                    `No user found with id=${userId}. You have to login first`,
                    'GET /login?name='
                );
            }

            handleError(res, error, 'GET /challenge?userId=&gameId=');
        }
    });

    app.get('/status', async (req, res) => {
        const { gameId } = req.query;

        if (!gameId) {
            handleError(res, 'gameId request param missing', 'GET /status?gameId=');
            return;
        }

        try {
            await checkGameExistence(gameId);

            const [{ created_by_user_id, createdByUsername, creation_date, won_by_user_id, winnerName }] =
                await queryPromise(
                    `SELECT game.created_by_user_id, u1.name as createdByUsername, game.creation_date, game.won_by_user_id, u2.name as winnerName FROM game
                    INNER JOIN user as u1 ON game.created_by_user_id=u1.id
                    LEFT JOIN user as u2 ON game.won_by_user_id=u2.id
                    WHERE game.id=${gameId};`
                );

            const players = await queryPromise(
                `SELECT g.user_id, user.name, g.user_order
                FROM game_user_sequence as g
                INNER JOIN user ON g.user_id=user.id
                WHERE g.game_id=${gameId}
                ORDER BY g.user_order;`
            );

            const result = {
                gameId,
                game: {
                    winner: winnerName ? `${winnerName} (id: ${won_by_user_id})` : '-',
                    ongoing: !_.isNumber(won_by_user_id),
                    creationDate: creation_date,
                    createdBy: `${createdByUsername} (id: ${created_by_user_id})`,
                    players: players.map(({ user_id, name, user_order }) => ({
                        id: user_id,
                        name,
                        order: user_order,
                    })),
                },
            };

            if (!winnerName) {
                const lastDeclaration = await getLastDeclaration(gameId);
                const nextPlayer = await getNextPlayer(gameId);

                res.json({
                    // spread operator
                    ...result,
                    ...lastDeclaration,
                    nextPlayer,
                });
            }

            res.json(result);
        } catch (error) {
            if (error instanceof GameNotFoundError) {
                handleError(res, `Game with id=${gameId} not found`, 'GET /last-declaration?gameId=');
                return;
            }

            handleError(res, error, 'GET /last-declaration?gameId=');
        }
    });

    app.get('/score', async (req, res) => {
        const { userId } = req.query;

        if (!userId) {
            // show all scores
            const scoreboard = await queryPromise(
                `SELECT s.id, s.user_id, user.name, s.score
                FROM scoreboard as s
                INNER JOIN user ON user.id=s.user_id;`
            );

            res.json({
                scoreboard: scoreboard.map(({ id, user_id, name, score }) => ({
                    id,
                    userId: user_id,
                    userName: name,
                    score,
                })),
            });
            return;
        }

        // show single user score
        const [scoreboard] = await queryPromise(
            `SELECT s.id, s.user_id, user.name, s.score
            FROM scoreboard as s
            INNER JOIN user ON user.id=s.user_id
            WHERE s.user_id=${userId};`
        );

        res.json({
            scoreboard: scoreboard
                ? {
                      id: scoreboard.id,
                      userId: scoreboard.user_id,
                      userName: scoreboard.name,
                      score: scoreboard.score,
                  }
                : {},
        });
    });
});

app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
});
