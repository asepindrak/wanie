# Wanie Deployment Guide

This guide covers deploying Wanie in various environments.

## Quick Start (Global CLI)

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
npm i -g @adens/wanie
```

### Run

```bash
wanie
```

This starts both frontend (port 55111) and backend (port 55222) and automatically opens your browser.

## Local Development

### Prerequisites

- Node.js 20+
- npm or yarn
- SQLite (included)

### Setup

```bash
git clone https://github.com/asepindrak/wanie.git
cd wanie
npm install
```

### Development Server

```bash
npm run dev
```

This starts both frontend (port 55111) and backend (port 55222) in development mode.

### Production Build

```bash
npm run build
npm start
```

## Docker Deployment

### Build Docker Image

```bash
docker build -t wanie:latest .
```

### Run Docker Container

```bash
docker run -p 55111:55111 \
  -e HOST=0.0.0.0 \
  -e FE_PORT=55111 \
  -e BE_PORT=55222 \
  -e WANIE_DATA_DIR=/app/storage \
  -e WANIE_HOME=/app/storage \
  -e DATABASE_URL=file:./storage/database/openwa.db \
  -v wanie-storage:/app/storage \
  wanie:latest
```

## Environment Configuration

Create `.env` in the repository root:

```env
# Host Configuration
HOST=0.0.0.0
FE_PORT=55111
BE_PORT=55222

# Security
WANIE_JWT_SECRET=your-secret-key-here

# Features
WANIE_AUTO_OPEN=false
WANIE_USE_WWEBJS=true
WANIE_ALLOW_MOCK=false

# Database
DATABASE_URL=file:./storage/database/openwa.db
```

Wanie will automatically derive frontend and backend URLs from `HOST`, `FE_PORT`, and `BE_PORT`.

### Environment Variables Explained

| Variable            | Default                           | Purpose                     |
| ------------------- | --------------------------------- | --------------------------- |
| `HOST`              | 127.0.0.1                         | Server host address         |
| `FE_PORT`           | 55111                             | Frontend port               |
| `BE_PORT`           | 55222                             | Backend API port            |
| `WANIE_JWT_SECRET` | wanie-local-dev-secret           | JWT signing secret          |
| `WANIE_AUTO_OPEN`  | true                              | Auto-open browser on start  |
| `WANIE_USE_WWEBJS` | true                              | Enable WhatsApp Web adapter |
| `WANIE_ALLOW_MOCK` | false                             | Allow mock adapter          |
| `DATABASE_URL`      | file:./storage/database/openwa.db | SQLite database path        |

## Database Migration

### First Run

On first run, Prisma automatically creates the database schema:

```bash
npm run build
npm start
```

### Manual Migration

```bash
npx prisma migrate deploy
```

### Database Reset

```bash
npx prisma migrate reset
```

## Reverse Proxy Configuration

### Nginx

```nginx
server {
    listen 80;
    server_name wanie.example.com;

    location / {
        proxy_pass http://localhost:55111;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Apache

```apache
<VirtualHost *:80>
    ServerName wanie.example.com

    ProxyPreserveHost On
    ProxyPass / http://localhost:55111/
    ProxyPassReverse / http://localhost:55111/
</VirtualHost>
```

## SSL/HTTPS Configuration

### Using Let's Encrypt with Nginx

```bash
certbot certonly --nginx -d wanie.example.com
```

Update Nginx configuration:

```nginx
listen 443 ssl http2;
ssl_certificate /etc/letsencrypt/live/wanie.example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/wanie.example.com/privkey.pem;
```

## Systemd Service File

Create `/etc/systemd/system/wanie.service`:

```ini
[Unit]
Description=Wanie AI Messaging CRM
After=network.target

[Service]
Type=simple
User=wanie
WorkingDirectory=/opt/wanie
Environment="NODE_ENV=production"
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Start service:

```bash
sudo systemctl enable wanie
sudo systemctl start wanie
```

## Monitoring

### Health Check

```bash
curl http://localhost:55111/health
```

### Logs

```bash
# Frontend logs
npm run logs:frontend

# Backend logs
npm run logs:backend
```

### Database Backup

```bash
cp storage/database/openwa.db backup/openwa.db.$(date +%Y%m%d_%H%M%S)
```

## Performance Optimization

### Node.js Memory

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm start
```

### Database Optimization

Enable WAL mode in SQLite:

```bash
sqlite3 storage/database/openwa.db "PRAGMA journal_mode=WAL;"
```

## Troubleshooting

### Port Already in Use

```bash
# Find process using port
lsof -i :55111

# Kill process
kill -9 <PID>
```

### Database Locked

```bash
# Reset database
npm run db:reset

# Or delete and recreate
rm -rf storage/database/openwa.db
npm start
```

### WhatsApp Session Issues

- Ensure WhatsApp account is not connected to another WhatsApp Web session
- Scan QR code quickly (expires after 20 seconds)
- Check internet connection stability
- Try disconnecting and reconnecting session

## Scaling

### Horizontal Scaling

- Separate frontend and backend deployments
- Use load balancer (Nginx, HAProxy)
- Share database via network path or managed database service
- Consider moving from SQLite to PostgreSQL

### Vertical Scaling

- Increase server resources (CPU, RAM)
- Optimize Node.js heap size
- Enable production mode (`NODE_ENV=production`)
- Use clustering for multiple worker processes

## Security Considerations

1. **Change Default JWT Secret**
   - Set `WANIE_JWT_SECRET` to a strong random value
   - Use secrets management tool (Vault, AWS Secrets Manager)

2. **API Key Management**
   - Rotate API keys regularly
   - Revoke unused keys
   - Monitor API key usage

3. **Database Security**
   - Backup database regularly
   - Use encrypted storage for database backups
   - Consider encrypted filesystem

4. **HTTPS/SSL**
   - Always use HTTPS in production
   - Use strong cipher suites
   - Enable HSTS header

5. **Rate Limiting**
   - Implement rate limiting on API endpoints
   - Monitor for unusual activity

6. **User Access**
   - Implement proper user authentication
   - Use strong password requirements
   - Enable account lockout after failed attempts

## Support

For issues and questions:

- GitHub Issues: https://github.com/asepindrak/wanie/issues
- Discussions: https://github.com/asepindrak/wanie/discussions
- Documentation: See README.md and FEATURES.md
