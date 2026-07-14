# Деплой VFS-Bot на VPS (pydoll)

Все шаги ниже одинаковы для любого провайдера — нужен просто чистый
Ubuntu 24.04 сервер с root/SSH доступом. Разница только в том, как вы его
создаёте.

## 1. Создать сервер

**DigitalOcean** (использовали в последний раз):
1. Регистрируетесь на digitalocean.com (ваше действие — своя учётка/оплата).
2. Create → Droplets:
   - Image: **Ubuntu 24.04 (LTS) x64**
   - Plan: Basic, Regular, **$6/мес** (1 vCPU, 2 GB RAM) — этого достаточно
   - Region: любой ближайший (Frankfurt/Amsterdam разумный выбор)
   - Authentication: SSH key (добавьте свой)
3. Дождитесь создания, скопируйте IP-адрес droplet'а.

**Hetzner** (если вернётесь к нему): Cloud → New Project → Add Server →
Ubuntu 24.04 → CX22 (~€4.35–5.39/мес) → добавить SSH-ключ.

**Vultr / Contabo**: тот же принцип — Ubuntu 24.04, минимальный/базовый
план, SSH-ключ.

## 2. Первичная настройка сервера

```
ssh root@<IP-адрес-сервера>
```

Скопируйте `deploy/setup_vps.sh` на сервер и запустите:

```
scp deploy/setup_vps.sh root@<IP>:/root/
ssh root@<IP> "bash /root/setup_vps.sh"
```

Скрипт установит: XFCE-десктоп + VNC-сервер, Google Chrome, Python, создаст
пользователя `vfsbot`. Вас спросят пароль для VNC — придумайте любой,
он нужен только для одноразового ручного логина.

## 3. Перенести код и конфиг

```
ssh root@<IP>
su - vfsbot
git clone https://github.com/baipeissov/visabot.git VFS-Bot-v2
cd VFS-Bot-v2
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

`config.ini` **не в git** — скопируйте его отдельно с вашего Mac:

```
scp VFS-Bot-v2/config.ini vfsbot@<IP>:~/VFS-Bot-v2/config.ini
```

В `config.ini` установите:
```
browser_backend = pydoll
```

## 4. Одноразовый ручной логин через VNC

На сервере (как пользователь vfsbot):
```
vncserver :1 -geometry 1280x800
```

С вашего Mac — пробросить порт и подключиться:
```
ssh -L 5901:localhost:5901 root@<IP>
```
Оставьте эту сессию открытой, в новом окне откройте **Screen Sharing**
(Finder → Go → Connect to Server → `vnc://localhost:5901`), введите VNC-пароль.

В открывшемся XFCE-рабочем столе, через терминал:
```
cd ~/VFS-Bot-v2
source venv/bin/activate
python3 login_setup.py
```
Откроется настоящее окно Chrome — залогиньтесь вручную (email, пароль,
пройдите Turnstile-капчу, Sign In), как обычный человек. Скрипт сам
определит, что вы дошли до дашборда, и завершится.

После этого VNC можно выключить:
```
vncserver -kill :1
```

## 5. Запустить как systemd-сервис (работает 24/7 без VNC)

Как root:
```
cp /home/vfsbot/VFS-Bot-v2/deploy/vfsbot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now vfsbot
systemctl status vfsbot
```

Логи:
```
journalctl -u vfsbot -f
```

## Если сессия истекла

Бот пришлёт в Telegram то же сообщение "сессия истекла", что и раньше.
Повторите шаг 4 (VNC + `login_setup.py`), сервис сам подхватит новую сессию
при следующей проверке — перезапускать вручную не обязательно.
