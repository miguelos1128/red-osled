@echo off
echo ================================
echo Iniciando SistemaCobros con PM2
echo ================================


pm2 kill




pm2 start app.js --name "SistemaCobros" --max-memory-restart 200M --watch


pm2 save

pm2 status

echo ================================
echo Servidor iniciado correctamente
echo ================================

pause