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
                hasBonusTurn: false,
                readyForNextGame: new Set()
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

    socket.on('requestNewGame', ({ roomCode }) => {
        let room = rooms[roomCode];
        if (!room) return;

        room.readyForNextGame.add(socket.id);
        
        let humanPlayers = room.players.filter(p => !p.isBot);
        io.to(roomCode).emit('logMessage', `🔄 Pelaaja on valmis uuteen peliin (${room.readyForNextGame.size}/${humanPlayers.length})`);

        if (room.readyForNextGame.size === humanPlayers.length) {
            room.readyForNextGame.clear();
            restartGame(roomCode);
        }
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

function restartGame(roomCode) {
    let room = rooms[roomCode];
    if (!room) return;

    room.table = { C: [], D: [], H: [], S: [] };
    room.hasBonusTurn = false;
    
    room.players.forEach(p => p.cards = []);

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

    io.to(roomCode).emit('logMessage', `✨ UUSI JAKO ALKOI! Peli nollattu.`);
    io.to(roomCode).emit('resetUI');
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
        let stolenCards = room.players[prevIndex].cards.splice(randIdx, 1);
        let stolenCard = stolenCards[0];
        room.players[currentIndex].cards.push(stolenCard);
        io.to(room.code).emit('logMessage', `🃏 ${room.players[currentIndex].username} ei voinut pelata ja ryösti kortin pelaajalta ${room.players[prevIndex].username}`);
    } else {
        io.to(room.code).emit('logMessage', `🃏 ${room.players[currentIndex].username} ei voinut pelata, mutta kenelläkään ei ole kortteja ryöstettäväksi!`);
    }

    let nextIndex = currentIndex;
    let attempts = 0;
    do {
        nextIndex = (nextIndex + 1) % room.players.length;
        attempts++;
    } while (room.players[nextIndex].cards.length === 0 && attempts < room.players.length);

    room.currentTurn = nextIndex;
    room.hasBonusTurn = false;

    broadcastState(room.code);

    if (room.players[room.currentTurn].isBot) {
        setTimeout(() => handleBotTurn(room.code), 1200);
    }
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
socket.on('roomData', ({ players, maxPlayers }) => {
    const list = document.getElementById('player-list');
    list.innerHTML = players.map(p => `<div>👤 ${p.username} liittynyt</div>`).join('');
    list.innerHTML += `<br><b>Tilanne: ${players.length} / ${maxPlayers} pelaajaa paikalla.</b>`;
});
socket.on('gameState', (data) => {
    document.getElementById('waiting-room').classList.add('hidden');
    document.getElementById('game-area').classList.remove('hidden');
    for (let suit in data.table) {
        const gridContainer = document.getElementById(`grid-${suit}`);
        gridContainer.innerHTML = "";
        let suitPile = data.table[suit]; let isRed = (suit === 'D' || suit === 'H');
        let hasSeven = suitPile.includes(7); let lowCards = suitPile.filter(v => v < 7); let highCards = suitPile.filter(v => v > 7);
        let topLow = lowCards.length > 0 ? Math.min(...lowCards) : null; let topHigh = highCards.length > 0 ? Math.max(...highCards) : null;
        let lowEl = document.createElement('div');
        if (topLow !== null) { lowEl.className = `table-card ${isRed ? 'red' : ''}`; lowEl.innerText = formatCardValue(topLow); }
        else { lowEl.className = "table-card empty"; lowEl.innerText = "-"; }
        gridContainer.appendChild(lowEl);
        let sevenEl = document.createElement('div');
        if (hasSeven) { sevenEl.className = `table-card ${isRed ? 'red' : ''}`; sevenEl.innerText = "7"; }
        else { sevenEl.className = "table-card empty"; sevenEl.innerText = "-"; }
        gridContainer.appendChild(sevenEl);
        let highEl = document.createElement('div');
        if (topHigh !== null) { highEl.className = `table-card ${isRed ? 'red' : ''}`; highEl.innerText = formatCardValue(topHigh); }
        else { highEl.className = "table-card empty"; highEl.innerText = "-"; }
        gridContainer.appendChild(highEl);
    }
    const myUsername = document.getElementById('username').value;
    const turnUser = data.playersData[data.currentTurn].username;
    const isMyTurn = turnUser === myUsername;
    const drawBtn = document.getElementById('draw-btn'); const endBonusBtn = document.getElementById('end-bonus-btn');
    if (isMyTurn) {
        if (data.hasBonusTurn) {
            document.getElementById('turn-info').innerHTML = `<span class="turn-highlight">⚡️ JATKOVUORO! Pelaa kortti tai lopeta.</span>`;
            drawBtn.disabled = true; endBonusBtn.classList.remove('hidden');
        } else {
            document.getElementById('turn-info').innerHTML = `<span class="turn-highlight">⭐️ SINUN VUOROSI!</span>`;
            drawBtn.disabled = data.canPlay; endBonusBtn.classList.add('hidden');
        }
    } else {
        document.getElementById('turn-info').innerHTML = data.hasBonusTurn ? `Pelaajan <b>${turnUser}</b> vapaaehtoinen jatkovuoro...` : `Vuorossa: <b>${turnUser}</b>`;
        drawBtn.disabled = true; endBonusBtn.classList.add('hidden');
    }
    document.getElementById('opponents-status').innerHTML = data.playersData.map(p => `<div><b>${p.username}:</b> ${p.cardCount} kpl</div>`).join('');
    const cardsDiv = document.getElementById('my-cards'); cardsDiv.innerHTML = "";
    data.myCards.forEach(card => {
        const isPlayable = data.validMoves.some(m => m.suit === card.suit && m.value === card.value);
        const cardEl = document.createElement('div');
        cardEl.className = `card ${isPlayable ? 'playable' : ''} ${(card.suit === 'D' || card.suit === 'H') ? 'red' : ''}`;
        cardEl.innerText = `${suitSymbols[card.suit]}${formatCardValue(card.value)}`;
        if (isMyTurn && isPlayable) {
            cardEl.onclick = () => { socket.emit('playCard', { roomCode: currentRoom, card }); };
        }
        cardsDiv.appendChild(cardEl);
    });
});
function drawCard() { socket.emit('drawCard', { roomCode: currentRoom }); }
function endBonusTurn() { socket.emit('endBonusTurn', { roomCode: currentRoom }); }
function requestNewGame() {
    document.getElementById('new-game-btn').disabled = true;
    document.getElementById('new-game-btn').innerText = "Odotetaan kaveria... ⏳";
    socket.emit('requestNewGame', { roomCode: currentRoom });
}
socket.on('gameOver', () => {
    document.getElementById('new-game-btn').classList.remove('hidden');
    document.getElementById('new-game-btn').disabled = false;
    document.getElementById('new-game-btn').innerText = "Haluan uuden pelin! 🔄";
    document.getElementById('turn-info').innerHTML = `🏁 <b>Peli päättyi!</b>`;
});
socket.on('resetUI', () => {
    document.getElementById('new-game-btn').classList.add('hidden');
});
socket.on('logMessage', (msg) => {
    const log = document.getElementById('log'); log.innerHTML += `<div>${msg}</div>`; log.scrollTop = log.scrollHeight;
});
socket.on('errorMsg', (msg) => alert(msg));
</script>
</body>
</html>
