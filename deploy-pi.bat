@echo off
rem Updates StrmProv on the Raspberry Pi.
rem The server is already installed there as a git checkout, so this copies deploy-pi.sh to the Pi and runs it:
rem it finds the StrmProv folder from the running server, does a git pull (keeping the provider switches you set
rem on the admin dashboard), installs npm packages when needed, restarts the services and checks they answer.
rem Push your changes to GitHub first - the Pi pulls from there, not from this PC.
rem You are asked for the Pi password twice (copy, then update) and possibly once for sudo.
setlocal
set PI=shulst@strmprov.local
set ADDON_PORT=3100
set ADMIN_PORT=3200

cd /d "%~dp0"
echo == Checking for changes that are not on GitHub yet
git fetch -q origin 2>nul
for /f %%c in ('git rev-list --count origin/main..HEAD 2^>nul') do set AHEAD=%%c
if not "%AHEAD%"=="" if not "%AHEAD%"=="0" (
  echo %AHEAD% commit^(s^) here are not pushed yet, so the Pi will not get them.
  choice /m "Continue anyway"
  if errorlevel 2 exit /b 1
)

echo == Copying the update script to %PI%
scp deploy-pi.sh %PI%:/tmp/strmprov-deploy.sh || goto :fail

echo == Updating on the Pi
ssh -t %PI% "sed -i 's/\r$//' /tmp/strmprov-deploy.sh; bash /tmp/strmprov-deploy.sh; rc=$?; rm -f /tmp/strmprov-deploy.sh; exit $rc" || goto :fail

echo.
echo Done. Addon: http://strmprov.local:%ADDON_PORT%/manifest.json
echo Dashboard: http://strmprov.local:%ADMIN_PORT%
pause
exit /b 0

:fail
echo.
echo Something went wrong; see the messages above.
pause
exit /b 1
