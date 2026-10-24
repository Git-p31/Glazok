// Функция для инициализации отслеживания реальной батареи
async function setupRealBattery(callback) {
  if ('getBattery' in navigator) {
    try {
      const battery = await navigator.getBattery();
      
      // Функция отправки актуальных данных
      const updateData = () => {
        const level = Math.round(battery.level * 100); // Переводим в проценты (0-100)
        const charging = battery.charging;             // Статус зарядки (true/false)
        callback(level, charging);
      };

      // Отправляем сразу при запуске
      updateData();

      // Подписываемся на события изменения уровня или статуса зарядки
      battery.addEventListener('levelchange', updateData);
      battery.addEventListener('chargingchange', updateData);
    } catch (e) {
      console.error("Не удалось получить доступ к Battery API", e);
    }
  } else {
    console.warn("Battery Status API не поддерживается этим браузером");
  }
}

// Пример интеграции в ваш цикл отправки статуса камеры:
setupRealBattery((batteryLevel, isCharging) => {
  // Эту структуру данных вы отправляете через WebSocket / WebRTC / сигнальный сервер
  const payload = {
    type: 'status_update',
    battery: batteryLevel, // Реальный процент заряда!
    charging: isCharging
  };
  
  // Пример отправки (замените на ваш метод передачи данных, например, dataChannel.send или socket.send)
  if (typeof sendDataToPeer === 'function') {
    sendDataToPeer(payload);
  }
});