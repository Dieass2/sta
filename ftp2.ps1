$FtpHost = ""
$FtpPort = "21"  # 21
$FtpUser = ""
$FtpPass = ""
$FilesToUpload = @(
    @{
        LocalFile  = "C:\diasprogi\p\s\camera1\final2\login.html"
        RemotePath = "/httpdocs/"
    },
    @{
        LocalFile  = "C:\diasprogi\p\s\camera1\final2\app.js"
        RemotePath = "/"
    },
    @{
        LocalFile  = "C:\diasprogi\p\s\camera1\final2\device.html"
        RemotePath = "/httpdocs/"
    }
)
function Upload-ToFtp {
    param(
        [string]$LocalFile,
        [string]$RemotePath,
        [string]$FtpHost,
        [string]$FtpPort,
        [string]$FtpUser,
        [string]$FtpPass
    )
    
    try {
        if (-not (Test-Path $LocalFile)) {
            Write-Host "error not found file: $LocalFile" -ForegroundColor Red
            return $false
        }

        $FileName = (Get-Item $LocalFile).Name
        
        if ($RemotePath -eq "/") {
            $RemoteFile = "/$FileName"
        } else {
            if (-not $RemotePath.EndsWith("/")) {
                $RemotePath = $RemotePath + "/"
            }
            $RemoteFile = $RemotePath + $FileName
        }
        
        $FtpUri = "ftp://${FtpHost}:${FtpPort}${RemoteFile}"

        Write-Host "download $LocalFile -> $FtpUri" -ForegroundColor Yellow

        $FtpRequest = [System.Net.FtpWebRequest]::Create($FtpUri)
        $FtpRequest.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile
        $FtpRequest.Credentials = New-Object System.Net.NetworkCredential($FtpUser, $FtpPass)
        $FtpRequest.UseBinary = $true
        $FtpRequest.KeepAlive = $false

        $FileContent = [System.IO.File]::ReadAllBytes($LocalFile)
        $FtpRequest.ContentLength = $FileContent.Length

        $FtpStream = $FtpRequest.GetRequestStream()
        $FtpStream.Write($FileContent, 0, $FileContent.Length)
        $FtpStream.Close()
        $FtpStream.Dispose()

        Write-Host "file $FileName successfully downloaded $RemotePath" -ForegroundColor Green
        return $true
    }
    catch {
        Write-Host "error with download $LocalFile : $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}
Write-Host "beginning" -ForegroundColor Cyan
$SuccessCount = 0
$TotalFiles = $FilesToUpload.Count
foreach ($File in $FilesToUpload) {
    $Result = Upload-ToFtp -LocalFile $File.LocalFile -RemotePath $File.RemotePath -FtpHost $FtpHost -FtpPort $FtpPort -FtpUser $FtpUser -FtpPass $FtpPass
    if ($Result) {
        $SuccessCount++
    }
    Start-Sleep -Milliseconds 500
}
Write-Host "success: $SuccessCount  $TotalFiles" -ForegroundColor Cyan
if ($SuccessCount -eq $TotalFiles) {
    Write-Host "all success!" -ForegroundColor Green
} else {
    Write-Host "not all files err" -ForegroundColor Yellow
}

Start-Sleep -Seconds 1

# $RpiIP = ""
# $User = ""
# $Password = "" 
# try {    
#     $SecurePass = ConvertTo-SecureString $Password -AsPlainText -Force # 4. Подключаемся по SSH
#     $Credential = New-Object System.Management.Automation.PSCredential ($User, $SecurePass)
#     $LocalFile = "C:\diasprogi\p\s\camera1\final2\main6.py"  # 5. Копируем файл
#     $RemotePath = "/home/dias/Desktop/"
#     Set-SCPItem -ComputerName $RpiIP -Credential $Credential `
#                 -Path $LocalFile -Destination $RemotePath `
#                 -AcceptKey
#     Write-Host "main6!" -ForegroundColor Green}
# catch {
#     Write-Host "error" -ForegroundColor Red
#     Pause
# }

# Start-Sleep -Seconds 1



