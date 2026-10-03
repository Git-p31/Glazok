"use strict";

const video = document.getElementById("video");
const status = document.getElementById("status");

let peer = null;
let dataConnection = null;
let call = null;

function getRoomCode() {
    const params = new URLSearchParams(window.location.search);

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

function createViewerId() {
    const random = crypto.randomUUID
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2) +
          Date.now().toString(36);

    return `glz-view-${random}`;
}

function cleanup() {

    if (call) {
        try {
            call.close();
        } catch {}

        call = null;
    }

    if (dataConnection) {
        try {
            dataConnection.close();
        } catch {}

        dataConnection = null;
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
     * ВАЖНО:
     *
     * View получает уникальный Peer ID.
     *
     * Он НЕ использует glz-ROOM.
     */

    const viewerId = createViewerId();

    peer = new Peer(viewerId, {
        config: {
            iceServers: [
                {
                    urls: "stun:stun.l.google.com:19302"
                },
                {
                    urls: "stun:stun1.l.google.com:19302"
                },
                {
                    urls: "stun:stun2.l.google.com:19302"
                }
            ]
        }
    });

    peer.on("open", () => {

        setStatus("Подключение к монитору...");

        /*
         * Подключаемся DATA-соединением
         * к основному монитору.
         */

        dataConnection = peer.connect(
            "glz-" + room,
            {
                reliable: true
            }
        );

        dataConnection.on("open", () => {

            /*
             * Сообщаем монитору:
             *
             * "Вот мой Peer ID.
             * Пришли мне видеопоток."
             */

            dataConnection.send({
                type: "clean-view",
                viewerId
            });

            setStatus("Ожидание видеосигнала...");
        });

        dataConnection.on("error", error => {

            console.error(
                "Viewer data connection error:",
                error
            );

            setStatus(
                "Ошибка подключения к монитору"
            );
        });

        dataConnection.on("close", () => {

            setStatus(
                "Соединение с монитором потеряно"
            );

        });
    });

    /*
     * Монитор позвонит этому Peer,
     * передав свой MediaStream.
     */

    peer.on("call", incomingCall => {

        if (call) {
            try {
                call.close();
            } catch {}
        }

        call = incomingCall;

        call.answer();

        call.on("stream", stream => {

            video.srcObject = stream;

            video.play().catch(() => {});

            hideStatus();

            console.log(
                "Clean Output: video stream received"
            );

        });

        call.on("close", () => {

            video.srcObject = null;

            setStatus(
                "Видеосигнал потерян"
            );
        });

        call.on("error", error => {

            console.error(
                "Clean Output WebRTC error:",
                error
            );

            setStatus(
                "Ошибка видеосоединения"
            );
        });
    });

    peer.on("error", error => {

        console.error(
            "Clean Output PeerJS error:",
            error
        );

        if (error.type === "unavailable-id") {
            setStatus(
                "Ошибка: ID просмотра уже используется"
            );
        } else {
            setStatus(
                "Ошибка подключения"
            );
        }
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