// Функция получения заряда батареи
async function setupBatteryMonitoring(peerConnection) {
    if ('getBattery' in navigator) {
        try {
            const battery = await navigator.getBattery();
            
            function sendBatteryStatus() {
                const data = {
                    type: 'DEVICE_STATUS',
                    deviceId: peer.id, // или уникальное имя телефона
                    deviceName: navigator.userAgentData?.platform || 'Mobile Device',
                    batteryLevel: Math.round(battery.level * 100),
                    charging: battery.charging
                };
                
                // Если у вас создан DataChannel для управления:
                if (window.controlDataChannel && window.controlDataChannel.readyState === 'open') {
                    window.controlDataChannel.send(JSON.stringify(data));
                }
            }

            // Отправляем при изменении и каждые 10 секунд
            battery.addEventListener('levelchange', sendBatteryStatus);
            battery.addEventListener('chargingchange', sendBatteryStatus);
            setInterval(sendBatteryStatus, 10000);
            sendBatteryStatus();
        } catch (e) {
            console.log('Battery API not supported/blocked', e);
        }
    }
}