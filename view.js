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
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" }
            ]
        }
    });

    peer.on("open", () => {
        status.textContent = "Подключение к Монитору...";
        
        // Связываемся с мотором (monitor.html)
        const conn = peer.connect("glz-" + roomCode);
        
        conn.on("open", () => {
            conn.send({ type: "clean-view", viewerId: viewerId });
            status.textContent = "Ожидание видеосигнала...";
        });
        
        conn.on("error", () => {
            status.textContent = "Ошибка соединения с Монитором";
        });
    });

    // Принимаем видеопоток от монитора
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