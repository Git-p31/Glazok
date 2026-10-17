// Хранилище активных входящих потоков по их Peer ID
const activeStreams = {};
let currentActivePeerId = null;

function switchDevice(targetPeerId) {
    if (activeStreams[targetPeerId]) {
        const videoElement = document.getElementById('remoteVideo');
        videoElement.srcObject = activeStreams[targetPeerId];
        currentActivePeerId = targetPeerId;
        
        // Обновляем визуальное выделение в списке интерфейса
        updateDevicesUI();
    }
}