"use strict";

const video = document.getElementById("video");
const status = document.getElementById("status");

let peer = null;
let call = null;

function getRoomCode() {
    const params = new URLSearchParams(
        window.location.search
    );

    return params
        .get("room")
        ?.trim()
        .toLowerCase();
}

function setStatus(text) {
    status.textContent = text;
    status.classList.remove("hidden");
}

function hideStatus() {
    status.classList.add("hidden");
}

function cleanup() {
    if (call) {
        try {
            call.close();
        } catch {}

        call = null;
    }

    if (peer) {
        try {
            peer.destroy();
        } catch {}

        peer = null;
    }

    video.srcObject = null;
}

function start() {

    const room = getRoomCode();

    if (!room) {
        setStatus("Нет кода комнаты");
        return;
    }

    /*
     * Монитор получает тот же Peer ID,
     * который создаёт телефон/камера.
     */

    const peerId = "glz-" + room;

    peer = new Peer(peerId, {
        config: {
            iceServers: [
                {
                    urls: "stun:stun.l.google.com:19302"
                },
                {
                    urls: "stun:stun1.l.google.com:19302"
                }
            ]
        }
    });

    peer.on("open", () => {
        setStatus("Ожидание камеры...");
    });

    peer.on("call", incomingCall => {

        if (call) {
            try {
                call.close();
            } catch {}
        }

        call = incomingCall;

        /*
         * Камере не нужно получать
         * обратный медиапоток.
         */

        call.answer();

        call.on("stream", stream => {

            video.srcObject = stream;

            video.play().catch(() => {});

            hideStatus();

        });

        call.on("close", () => {

            video.srcObject = null;

            setStatus("Камера отключена");

        });

        call.on("error", error => {

            console.error(
                "WebRTC call error:",
                error
            );

            setStatus("Ошибка видеосоединения");

        });

    });

    peer.on("error", error => {

        console.error(
            "PeerJS error:",
            error
        );

        setStatus(
            "Ошибка подключения"
        );

    });

    peer.on("disconnected", () => {

        setStatus(
            "Соединение потеряно..."
        );

    });

}

window.addEventListener(
    "beforeunload",
    cleanup
);

start();