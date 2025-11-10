CALL "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
REM APPDATA is empty in CMD, and npm requires it to at least be empty
SET APPDATA=""

npm run build
npm run test-ci
