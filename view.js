"use strict";

const video = document.getElementById("video");
const status = document.getElementById("status");

const params = new URLSearchParams(window.location.search);
const room = params.get("room");

if (!room) {
    status.textContent = "Не указан код комнаты";
} else {
    initViewer(room.toLowerCase());
}

function initViewer(roomCode) {
    const viewerId = "glz-view-" + Math.random().toString(36).substring(2, 9);
    
    const peer = new Peer(viewerId, {
        config: {
            iceServers: [
                {
                    urls: "stun:stun.relay.metered.ca:80",
                },
                {
                    urls: "turn:standard.relay.metered.ca:80",
                    username: "35162de63b0eb72fbb27f4e3",
                    credential: "ZbW2aJl3WmRUyOss",
                },
                {
                    urls: "turn:standard.relay.metered.ca:80?transport=tcp",
                    username: "35162de63b0eb72fbb27f4e3",
                    credential: "ZbW2aJl3WmRUyOss",
                },
                {
                    urls: "turn:standard.relay.metered.ca:443",
                    username: "35162de63b0eb72fbb27f4e3",
                    credential: "ZbW2aJl3WmRUyOss",
                },
                {
                    urls: "turns:standard.relay.metered.ca:443?transport=tcp",
                    username: "35162de63b0eb72fbb27f4e3",
                    credential: "ZbW2aJl3WmRUyOss",
                }
            ]
        }
    });

    peer.on("open", () => {
        status.textContent = "Подключение к Монитору...";
        
        const conn = peer.connect("glz-" + roomCode);
        
        conn.on("open", () => {
            conn.send({ type: "clean-view", viewerId: viewerId });
            status.textContent = "Ожидание видеосигнала...";
        });
        
        conn.on("error", () => {
            status.textContent = "Ошибка соединения с Монитором";
        });
    });

    peer.on("call", call => {
        call.answer();
        
        call.on("stream", stream => {
            video.srcObject = stream;
            video.muted = true;
            video.play().catch(() => {});
            status.style.display = "none";
        });

        call.on("close", () => {
            status.style.display = "block";
            status.textContent = "Трансляция завершена";
            video.srcObject = null;
        });
    });

    peer.on("error", err => {
        console.error("Peer error:", err);
        status.style.display = "block";
        status.textContent = "Ошибка соединения";
    });
}