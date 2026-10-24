// === ОТПРАВКА РЕАЛЬНОГО ЗАРЯДА БАТАРЕИ ===
async function initBatterySender(dataConnection) {
  if (!('getBattery' in navigator)) {
    console.warn("Battery API не поддерживается на этом устройстве");
    return;
  }

  try {
    const battery = await navigator.getBattery();

    const sendBattery = () => {
      if (dataConnection && dataConnection.open) {
        dataConnection.send({
          type: "battery-update",
          level: Math.round(battery.level * 100), // Реальные 0-100%
          charging: battery.charging               // true / false
        });
      }
    };

    // Отправляем сразу после соединения
    sendBattery();

    // Слушаем изменение уровня заряда и подключение к сети
    battery.addEventListener("levelchange", sendBattery);
    battery.addEventListener("chargingchange", sendBattery);

    // Дополнительный интервал каждые 5 секунд
    setInterval(sendBattery, 5000);

  } catch (err) {
    console.error("Ошибка Battery API:", err);
  }
}

// Вызови эту функцию в месте, где у тебя открывается DataConnection (канал управления):
// conn.on("open", () => { initBatterySender(conn); });