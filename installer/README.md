# Vencord + Delexo Plugins installer

Windows installer for official Vencord plus Delexo plugins.

```bat
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o .\publish
```

The published exe is `Vencord Plugins Installer.exe`. GitHub releases use the name `Vencord-Plugins-Installer.exe`.
