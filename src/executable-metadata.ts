import { promises as fs } from 'fs';
import path from 'path';
import semver from 'semver';

export type ExecutableMetadata = {
  name?: string, // exe rc InternalName and ProductName
  description?: string, // exe rc FileDescription
  version?: string, // exe rc FileVersion and ProductVersion
  manufacturer?: string, // exe rc CompanyName
  copyright?: string, // exe rc LegalCopyright
  icon?: string // ico file path
};

export async function generateRCFile (
  resourcePath: string,
  executableFilename: string,
  data: ExecutableMetadata = {}): Promise<string> {
  const S = JSON.stringify;
  let result = '#include "winresrc.h"\n';
  if (data.icon) {
    await fs.copyFile(data.icon, path.join(resourcePath, 'boxednode.ico'));
    result += '1 ICON boxednode.ico\n';
  }
  const version = semver.parse(data.version || '0.0.0');
  result += `

// Version resource
VS_VERSION_INFO VERSIONINFO
 FILEVERSION ${version.major},${version.minor},${version.patch},0
 PRODUCTVERSION ${version.major},${version.minor},${version.patch},0
 FILEFLAGSMASK 0x3fL
#ifdef _DEBUG
 FILEFLAGS VS_FF_DEBUG
#else
#  ifdef NODE_VERSION_IS_RELEASE
    FILEFLAGS 0x0L
#  else
    FILEFLAGS VS_FF_PRERELEASE
#  endif
#endif

 FILEOS VOS_NT_WINDOWS32
 FILETYPE VFT_APP
 FILESUBTYPE 0x0L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "FileVersion", ${S(version.version)}
            VALUE "ProductVersion", ${S(version.version)}`;
  if (data.manufacturer) {
    result += `
            VALUE "CompanyName", ${S(data.manufacturer)}`;
  }
  if (data.name) {
    result += `
            VALUE "InternalName", ${S(data.name)}
            VALUE "ProductName", ${S(data.name)}`;
  }
  if (data.copyright) {
    result += `
            VALUE "LegalCopyright", ${S(data.copyright)}`;
  }
  if (data.description) {
    result += `
            VALUE "FileDescription", ${S(data.description)}`;
  }
  result += `
            VALUE "OriginalFilename", ${S(path.basename(executableFilename))}
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x409, 1200
    END
END
`;
  return result;
}
