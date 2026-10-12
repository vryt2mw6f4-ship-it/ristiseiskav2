const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

function createDeck() {
    const suits = ['C', 'D', 'H', 'S'];
    let deck = [];
    for (let suit of suits) {
        for (let value = 1; value <= 13; value++) {
            deck.push({ suit, value });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomCode, username, totalPlayers }) => {
        socket.join(roomCode);
        
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                code: roomCode,
                players: [],
                deck: [],
                table: { C: [], D: [], H: [], S: [] },
                currentTurn: 0,
                gameStarted: false,
                maxPlayers: parseInt(totalPlayers) || 4,
                hasBonusTurn: false
            };
        }

        let room = rooms[roomCode];
        if (room.gameStarted) return;

        room.players.push({ id: socket.id, username, cards: [], isBot: false });
        io.to(roomCode).emit('roomData', { players: room.players, maxPlayers: room.maxPlayers });

        if (room.players.length === room.maxPlayers) {
            startGame(roomCode);
        }
    });

    socket.on('playCard', ({ roomCode, card }) => {
        let room = rooms[roomCode];
        if (!room) return;
        let activePlayer = room.players[room.currentTurn];
        if (activePlayer.id !== socket.id) return;

        activePlayer.cards = activePlayer.cards.filter(c => !(c.suit === card.suit && c.value === card.value));
        room.table[card.suit].push(card.value);
        room.table[card.suit].sort((a,b) => a-b);

        if ((card.value === 1 || card.value === 13) && activePlayer.cards.length > 0) {
            room.hasBonusTurn = true;
            io.to(roomCode).emit('logMessage', `🃏 ${activePlayer.username} pelasi sulkukortin (${card.value === 1 ? 'A' : 'K'}) ja sai vapaaehtoisen jatkovuoron!`);
            broadcastState(roomCode);
            
            if (activePlayer.isBot) {
                setTimeout(() => handleBotBonusTurn(roomCode), 1200);
            }
        } else {
            room.hasBonusTurn = false;
            checkWinAndNextTurn(roomCode);
        }
    });

    socket.on('endBonusTurn', ({ roomCode }) => {
        let room = rooms[roomCode];
        if (!room || !room.hasBonusTurn) return;
        let activePlayer = room.players[room.currentTurn];
        if (activePlayer.id !== socket.id) return;

        room.hasBonusTurn = false;
        io.to(roomCode).emit('logMessage', `${activePlayer.username} lopetti jatkovuoronsa.`);
        checkWinAndNextTurn(roomCode);
    });

    socket.on('drawCard', ({ roomCode }) => {
        let room = rooms[roomCode];
        if (!room || room.hasBonusTurn) return;
        let activePlayer = room.players[room.currentTurn];
        if (activePlayer.id !== socket.id) return;

        stealCardLogic(room);
    });
});

function startGame(roomCode) {
    let room = rooms[roomCode];
    room.gameStarted = true;

    let botCount = 1;
    while (room.players.length < 4) {
        room.players.push({ id: 'bot_' + botCount, username: `Botti ${botCount}`, cards: [], isBot: true });
        botCount++;
    }

    let deck = createDeck();
    let playerIndex = 0;
    while (deck.length > 0) {
        room.players[playerIndex % room.players.length].cards.push(deck.pop());
        playerIndex++;
    }

    for (let i = 0; i < room.players.length; i++) {
        if (room.players[i].cards.some(c => c.suit === 'C' && c.value === 7)) {
            room.currentTurn = i;
            break;
        }
    }

    broadcastState(roomCode);
    if (room.players[room.currentTurn].isBot) {
        setTimeout(() => handleBotTurn(roomCode), 1200);
    }
}

function getValidMoves(cards, table) {
    let valid = [];
    let hasClub7 = cards.some(c => c.suit === 'C' && c.value === 7);
    
    if (hasClub7 && table.C.length === 0) {
        return cards.filter(c => c.suit === 'C' && c.value === 7);
    }

    for (let card of cards) {
        let suitPile = table[card.suit];
        if (card.value === 7) {
            valid.push(card);
        } else if (suitPile.includes(7)) {
            let hasSix = suitPile.includes(6);
            let hasEight = suitPile.includes(8);

            if (card.value === 6) {
                valid.push(card);
            } else if (card.value === 8 && hasSix) {
                valid.push(card);
            } else if (hasSix && hasEight) {
                let lowCards = suitPile.filter(v => v <= 7);
                let highCards = suitPile.filter(v => v >= 7);
                let minVal = Math.min(...lowCards);
                let maxVal = Math.max(...highCards);

                if (card.value === minVal - 1 || card.value === maxVal + 1) {
                    valid.push(card);
                }
            }
        }
    }
    return valid;
}

function stealCardLogic(room) {
    let currentIndex = room.currentTurn;
    let prevIndex = (currentIndex - 1 + room.players.length) % room.players.length;
    
    while (room.players[prevIndex].cards.length === 0 && prevIndex !== currentIndex) {
        prevIndex = (prevIndex - 1 + room.players.length) % room.players.length;
    }

    if (room.players[prevIndex].cards.length > 0) {
        let randIdx = Math.floor(Math.random() * room.players[prevIndex].cards.length);
        let stolenCard = room.players[prevIndex].cards.splice(randIdx, 1);
        room.players[currentIndex].cards.push(stolenCard);
        io.to(room.code).emit('logMessage', `${room.players[currentIndex].username} ryösti kortin pelaajalta ${room.players[prevIndex].username}`);
    }
    checkWinAndNextTurn(room.code);
}

function handleBotTurn(roomCode) {
    let room = rooms[roomCode];
    if (!room) return;
    let bot = room.players[room.currentTurn];
    if (!bot || !bot.isBot) return;

    let validMoves = getValidMoves(bot.cards, room.table);

    if (validMoves.length > 0) {
        let cardToPlay = validMoves[0];
        bot.cards = bot.cards.filter(c => !(c.suit === cardToPlay.suit && c.value === cardToPlay.value));
        room.table[cardToPlay.suit].push(cardToPlay.value);
        room.table[cardToPlay.suit].sort((a,b) => a-b);
        io.to(roomCode).emit('logMessage', `${bot.username} pelasi: ${cardToPlay.suit}-${cardToPlay.value}`);

        if ((cardToPlay.value === 1 || cardToPlay.value === 13) && bot.cards.length > 0) {
            room.hasBonusTurn = true;
            broadcastState(roomCode);
            setTimeout(() => handleBotBonusTurn(roomCode), 1200);
        } else {
            room.hasBonusTurn = false;
            checkWinAndNextTurn(roomCode);
        }
    } else {
        stealCardLogic(room);
    }
}

function handleBotBonusTurn(roomCode) {
    let room = rooms[roomCode];
    if (!room) return;
    let bot = room.players[room.currentTurn];
    
    let validMoves = getValidMoves(bot.cards, room.table);
    if (validMoves.length > 0) {
        handleBotTurn(roomCode);
    } else {
        room.hasBonusTurn = false;
        io.to(roomCode).emit('logMessage', `${bot.username} päätti jatkovuoronsa.`);
        checkWinAndNextTurn(roomCode);
    }
}

function checkWinAndNextTurn(roomCode) {
    let room = rooms[roomCode];
    let activePlayer = room.players[room.currentTurn];

    if (activePlayer.cards.length === 0) {
        io.to(roomCode).emit('logMessage', `🎉 ${activePlayer.username} pääsi eroon kaikista korteistaan!`);
    }

    let attempts = 0;
    do {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
        attempts++;
    } while (room.players[room.currentTurn].cards.length === 0 && attempts < room.players.length);

    broadcastState(roomCode);

    let activePlayersLeft = room.players.filter(p => p.cards.length > 0).length;
    if (activePlayersLeft <= 1) {
        io.to(roomCode).emit('gameOver', 'Peli päättyi!');
        return;
    }

    if (room.players[room.currentTurn].isBot) {
        setTimeout(() => handleBotTurn(roomCode), 1200);
    }
}

function broadcastState(roomCode) {
    let room = rooms[roomCode];
    room.players.forEach(p => {
        if (!p.isBot) {
            let validMoves = getValidMoves(p.cards, room.table);
            io.to(p.id).emit('gameState', {
                table: room.table,
                currentTurn: room.currentTurn,
                playersData: room.players.map(pl => ({ username: pl.username, cardCount: pl.cards.length })),
                myCards: p.cards,
                canPlay: validMoves.length > 0,
                validMoves: validMoves,
                hasBonusTurn: room.hasBonusTurn
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Palvelin käynnissä portissa ${PORT}`));
