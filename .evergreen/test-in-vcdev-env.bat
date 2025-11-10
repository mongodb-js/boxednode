CALL "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
REM APPDATA is empty in CMD, and npm requires it to be a valid path
SET APPDATA="%TEMP%\npm-cache"

CALL npm run build
CALL npm run test-ci
