# FTP
$FtpHost = "185.98.5.149"
$FtpPort = "21"  # 21
$FtpUser = "ecodom_asia"
$FtpPass = "Dioptriy0"

# Local file and destination path
$LocalFile2 = "C:\diasprogi\p\s\camera1\final2\app.js"
$RemotePath2 = "/"

try {
    # Check if local file exists
    if (-not (Test-Path $LocalFile2)) {
        throw "Local file not found: $LocalFile2"
    }

    # Create FTP URI
    $RemoteFile2 = "$RemotePath2/$((Get-Item $LocalFile2).Name)"
    $FtpUri = "ftp://${FtpHost}:${FtpPort}${RemoteFile2}"

    # Create FTP request
    $FtpRequest = [System.Net.FtpWebRequest]::Create($FtpUri)
    $FtpRequest.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile
    $FtpRequest.Credentials = New-Object System.Net.NetworkCredential($FtpUser, $FtpPass)
    $FtpRequest.UseBinary = $true
    $FtpRequest.KeepAlive = $false

    # Read file and write to FTP stream
    $FileContent = [System.IO.File]::ReadAllBytes($LocalFile2)
    $FtpRequest.ContentLength = $FileContent.Length

    $FtpStream = $FtpRequest.GetRequestStream()
    $FtpStream.Write($FileContent, 0, $FileContent.Length)
    $FtpStream.Close()

    Write-Host "app.js uploaded successfully!" -ForegroundColor Green
}
catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
}