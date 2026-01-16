// код для raspberry pi 5
package main

import (
	"context"
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	// "net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"firebase.google.com/go/v4"
	"firebase.google.com/go/v4/messaging"
	"github.com/SherClockHolmes/webpush-go"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/joho/godotenv"
	"google.golang.org/api/option"
)

var (
	userStates         = sync.Map{}
	activeHlsProcesses = sync.Map{}
	activeMonitors     = sync.Map{}
	alertCooldowns     = sync.Map{}
	ffmpegPath         = "./ffmpeg"
	publicVapidKey     = "BKqo5382Bum34XP61OtXZZzcUDyYIZblUFOwZDYhlMe2wVTTM74UOHIM_gaBfVmCYpQKrh58dINlVdCfIN5xdcE"
	privateVapidKey    string
	firebaseApp        *firebase.App
	bot                *tgbotapi.BotAPI
	CSV_FILES          = map[string]string{
		"users":       "users.csv",
		"devices":     "devices.csv",
		"tg":          "tg.csv",
		"sensor_data": "sensor_data.csv",
		"rpi":         "rpi.csv",
		"subs":        "subs.csv",
		"ip_cameras":  "ip_cameras.csv",
		"fcm_tokens":  "fcm_tokens.csv",
	}
)


var Dictionary = map[string]map[string]string{
	"ru": {
        "welcome": "Добро пожаловать в EcoDom Bot!",
        "auth_success": "Авторизация прошла успешно!",
        "auth_fail": "Ошибка авторизации. Проверьте логин/пароль.",
        "menu_main": "Главное меню:",
        "btn_sensors": "🌡 Сенсоры",
        "btn_devices": "📹 Устройства",
        "btn_settings": "⚙ Настройки",
        "btn_wifi": "📶 WiFi",
        "btn_lang": "🌐 Язык",
        "current_data": "Текущие данные:",
        "history_24h": "История (24ч)",
        "no_data": "Нет данных",
        "dev_list": "Список устройств:",
        "dev_online": "Онлайн",
        "dev_offline": "Офлайн",
        "dev_videos": "Видео",
        "dev_delete": "Удалить",
        "video_list": "Записи видео:",
        "confirm_del": "Вы уверены?",
        "settings_title": "Настройки пользователя:",
        "pass_change": "Сменить пароль",
        "pass_enter": "Введите новый пароль:",
        "pass_updated": "Пароль обновлен!",
        "wifi_title": "Настройки WiFi (rpi.csv):",
        "wifi_change": "Изменить WiFi",
        "wifi_enter_ssid": "Введите SSID (название сети):",
        "wifi_enter_pass": "Введите пароль WiFi:",
        "wifi_updated": "WiFi настройки обновлены!",
        "alerts": "Уведомления и режимы:",
        "on": "ВКЛ",
        "off": "ВЫКЛ",
        "tg_id": "Ваш Telegram ID:",
        "lang_select": "Выберите язык / Select language:",
        "back": "⬅ Назад",
    },
    "en": {
        "welcome": "Welcome to EcoDom Bot!",
        "auth_success": "Authorization successful!",
        "auth_fail": "Auth error. Check credentials.",
        "menu_main": "Main Menu:",
        "btn_sensors": "🌡 Sensors",
        "btn_devices": "📹 Devices",
        "btn_settings": "⚙ Settings",
        "btn_wifi": "📶 WiFi",
        "btn_lang": "🌐 Language",
        "current_data": "Current Data:",
        "history_24h": "History (24h)",
        "no_data": "No data",
        "dev_list": "Devices List:",
        "dev_online": "Online",
        "dev_offline": "Offline",
        "dev_videos": "Videos",
        "dev_delete": "Delete",
        "video_list": "Video Records:",
        "confirm_del": "Are you sure?",
        "settings_title": "User Settings:",
        "pass_change": "Change Password",
        "pass_enter": "Enter new password:",
        "pass_updated": "Password updated!",
        "wifi_title": "WiFi Settings (rpi.csv):",
        "wifi_change": "Change WiFi",
        "wifi_enter_ssid": "Enter SSID:",
        "wifi_enter_pass": "Enter WiFi Password:",
        "wifi_updated": "WiFi settings updated!",
        "alerts": "Alerts & Modes:",
        "on": "ON",
        "off": "OFF",
        "tg_id": "Your Telegram ID:",
        "lang_select": "Select language:",
        "back": "⬅ Back",
    },
    "kz": {
        "welcome": "EcoDom Bot-қа қош келдіңіз!",
        "auth_success": "Авторизация сәтті өтті!",
        "auth_fail": "Қате. Логин/парольді тексеріңіз.",
        "menu_main": "Басты мәзір:",
        "btn_sensors": "🌡 Сенсорлар",
        "btn_devices": "📹 Құрылғылар",
        "btn_settings": "⚙ Баптаулар",
        "btn_wifi": "📶 WiFi",
        "btn_lang": "🌐 Тіл",
        "current_data": "Ағымдағы деректер:",
        "history_24h": "Тарих (24 сағ)",
        "no_data": "Деректер жоқ",
        "dev_list": "Құрылғылар тізімі:",
        "dev_online": "Онлайн",
        "dev_offline": "Офлайн",
        "dev_videos": "Бейнелер",
        "dev_delete": "Жою",
        "video_list": "Бейне жазбалар:",
        "confirm_del": "Сенімдісіз бе?",
        "settings_title": "Пайдаланушы баптаулары:",
        "pass_change": "Құпиясөзді өзгерту",
        "pass_enter": "Жаңа құпиясөзді енгізіңіз:",
        "pass_updated": "Құпиясөз жаңартылды!",
        "wifi_title": "WiFi баптаулары (rpi.csv):",
        "wifi_change": "WiFi өзгерту",
        "wifi_enter_ssid": "SSID енгізіңіз:",
        "wifi_enter_pass": "WiFi құпиясөзін енгізіңіз:",
        "wifi_updated": "WiFi баптаулары жаңартылды!",
        "alerts": "Хабарландырулар мен режимдер:",
        "on": "ҚОСУЛЫ",
        "off": "ӨШІРУЛІ",
        "tg_id": "Telegram ID:",
        "lang_select": "Тілді таңдаңыз:",
        "back": "⬅ Артқа",
    },
}



func setupSafeLog() {
	logFile, _ := os.OpenFile("server.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0666)
	
	multiWriter := io.MultiWriter(os.Stdout, logFile)
	log.SetOutput(multiWriter)
	log.SetFlags(0)

	gin.DefaultWriter = multiWriter
	gin.DefaultErrorWriter = multiWriter
}

func customLog(args ...interface{}) {
	location := time.FixedZone("UTC+5", 5*60*60)
	timeStr := time.Now().In(location).Format("2006-01-02 15:04:05")
	msg := fmt.Sprint(args...)
	fmt.Printf("%s %s\n", timeStr, msg)
}

func initCsvFiles() {
	createFile := func(key string, headers []string) {
		if _, err := os.Stat(CSV_FILES[key]); os.IsNotExist(err) {
			f, _ := os.Create(CSV_FILES[key])
			w := csv.NewWriter(f)
			w.Write(headers)
			w.Flush()
			f.Close()
			customLog("✅ Created ", CSV_FILES[key])
		}
	}
	createFile("users", []string{"rpi_id", "password", "last_seen", "global_ip", "co2_alert", "pir_alert", "power_alert", "away_mode"})
	createFile("devices", []string{"rpi_id", "token", "os", "last_ip", "last_seen", "seconds", "has_flash", "video_count", "battery_level", "is_charging", "pending_command", "pending_value"})
	createFile("sensor_data", []string{"rpi_id", "temp", "humidity", "co_ppm", "solar_voltage", "wind_voltage", "battery_level", "motion", "timestamp"})
	createFile("rpi", []string{"rpi_id", "wifi_ssid", "wifi_password"})
	createFile("tg", []string{"rpi_id", "username", "chat_id", "last_seen", "lang"})
	createFile("ip_cameras", []string{"id", "rpi_id", "name", "rtsp_full"})
	createFile("fcm_tokens", []string{"rpi_id", "token", "updated_at"})
	createFile("subs", []string{"rpi_id", "endpoint", "p256dh", "auth"})
}



func getD(lang string) map[string]string {
	if d, ok := Dictionary[lang]; ok {
		return d
	}
	return Dictionary["ru"]
}


func readCSV(fileType string) ([]map[string]string, error) {
	f, err := os.Open(CSV_FILES[fileType])
	if err != nil { return nil, err }
	defer f.Close()
	records, _ := csv.NewReader(f).ReadAll()
	if len(records) < 1 { return []map[string]string{}, nil }
	headers := records[0]
	var res []map[string]string
	for _, row := range records[1:] {
		obj := make(map[string]string)
		for i, h := range headers {
			if i < len(row) { obj[h] = row[i] } else { obj[h] = "" }
		}
		res = append(res, obj)
	}
	return res, nil
}

func writeCSV(fileType string, data map[string]string) error {
	f, _ := os.Open(CSV_FILES[fileType])
	headers, _ := csv.NewReader(f).Read()
	f.Close()
	file, _ := os.OpenFile(CSV_FILES[fileType], os.O_APPEND|os.O_WRONLY, 0644)
	defer file.Close()
	var row []string
	for _, h := range headers { row = append(row, data[h]) }
	w := csv.NewWriter(file)
	w.Write(row)
	w.Flush()
	return nil
}

func rewriteCSV(fileType string, headers []string, data []map[string]string) {
	f, _ := os.Create(CSV_FILES[fileType])
	defer f.Close()
	w := csv.NewWriter(f)
	w.Write(headers)
	for _, d := range data {
		var row []string
		for _, h := range headers { row = append(row, d[h]) }
		w.Write(row)
	}
	w.Flush()
}

func updateCSVRecord(fileType, key, val string, updates map[string]string) bool {
	records, _ := readCSV(fileType)
	if len(records) == 0 { return false }
	var headers []string
	for k := range records[0] { headers = append(headers, k) }
	updated := false
	for i, r := range records {
		if r[key] == val {
			for uk, uv := range updates { records[i][uk] = uv }
			updated = true
		}
	}
	if updated { rewriteCSV(fileType, headers, records) }
	return updated
}

func generateToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func canSendAlert(rpiID, alertType string) bool {
	key := rpiID + "_" + alertType
	now := time.Now()
	if last, ok := alertCooldowns.Load(key); ok {
		if now.Sub(last.(time.Time)) < 60*time.Second { return false }
	}
	alertCooldowns.Store(key, now)
	return true
}


func main() {
	godotenv.Load()
	setupSafeLog()
	privateVapidKey = os.Getenv("pvk")
	if runtime.GOOS == "windows" {
		ffmpegPath = "ffmpeg.exe"
	}

	initCsvFiles()
	_ = os.MkdirAll("streams", 0777)
	_ = os.MkdirAll("users_videos", 0777)

	initFirebase()

	r := gin.Default()

	r.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Origin, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, devicetoken")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	setupStreamRoutes(r)
	setupCameraRoutes(r)
	setupWebPushRoutes(r)
	setupFCMRoutes(r)
	setupApiRoutes(r)
	setupWebInterfaceRoutes(r)
	setupHistoryAndFilesRoutes(r)
	setupFinalRoutes(r)

	r.Static("/streams", "./streams")
	r.Static("/users_videos", "./users_videos")
	
	r.StaticFile("/", "./index.html")
	r.StaticFile("/index.js", "./index.js")
	r.StaticFile("/index.css", "./index.css")
	// r.Static("/public", "./public") 		// если есть папка со значками или манифестом

	go initTelegramBot()

	port := "8767"
	customLog("🚀 HTTP Server running on port ", port)
	err := r.Run(":" + port)
	if err != nil {
		customLog("❌ Critical error: ", err)
	}
}

type Camera struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	RtspFull string `json:"rtsp_full"`
}

type FCMToken struct {
	RpiID     string `json:"rpi_id"`
	Token     string `json:"fcm_token"`
	UpdatedAt string `json:"updated_at"`
}


func initFirebase() {
	serviceAccountPath := "./ecodom-asia-firebase-adminsdk-fbsvc-df3cbf6d46.json"
	if _, err := os.Stat(serviceAccountPath); os.IsNotExist(err) {
		customLog("⚠️ Файл Firebase JSON не найден, пуши работать не будут")
		return
	}

	opt := option.WithCredentialsFile(serviceAccountPath)
	app, err := firebase.NewApp(context.Background(), nil, opt)
	if err != nil {
		customLog("❌ Ошибка инициализации Firebase: ", err)
		return
	}
	firebaseApp = app
}

func readCamerasCSV() ([]Camera, error) {
	file, err := os.Open("ip_cameras.csv")
	if err != nil {
		return nil, err
	}
	defer file.Close()

	reader := csv.NewReader(file)
	records, _ := reader.ReadAll()
	var cams []Camera
	for i, r := range records {
		if i == 0 { continue } // пропускаем заголовок
		cams = append(cams, Camera{ID: r[0], Name: r[1], RtspFull: r[2]})
	}
	return cams, nil
}


func setupStreamRoutes(r *gin.Engine) {
	

	r.POST("/api/hls/start", func(c *gin.Context) {
		var req struct{ ID string `json:"id"` }
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}

		cams, _ := readCamerasCSV()
		var cam *Camera
		for _, v := range cams {
			if v.ID == req.ID { cam = &v; break }
		}

		if cam == nil {
			c.JSON(404, gin.H{"error": "Cam not found"})
			return
		}

		camDir := filepath.Join("streams", req.ID)
		_ = os.RemoveAll(camDir)
		_ = os.MkdirAll(camDir, 0777)

		playlistFile := filepath.Join(camDir, "index.m3u8")

		if proc, ok := activeHlsProcesses.Load(req.ID); ok {
			_ = proc.(*exec.Cmd).Process.Kill()
		}

		customLog("🎬 HLS START: " + cam.Name)

		args := []string{"-y", "-fflags", "nobuffer"}
		if strings.HasPrefix(cam.RtspFull, "rtsp://") {
			args = append(args, "-rtsp_transport", "tcp")
		}
		args = append(args, "-i", cam.RtspFull, "-c:v", "copy", "-c:a", "aac", "-f", "hls", 
			"-hls_time", "2", "-hls_list_size", "5", "-hls_flags", "delete_segments", playlistFile)

		cmd := exec.Command(ffmpegPath, args...)
		
		
		stderr, _ := cmd.StderrPipe()
		go func() {
			scanner := csv.NewReader(stderr) 
			_ = scanner
			buf := make([]byte, 1024)
			for {
				n, err := stderr.Read(buf)
				if n > 0 {
					msg := string(buf[:n])
					if strings.Contains(msg, "Error") || strings.Contains(msg, "refused") {
						customLog(fmt.Sprintf("[FFmpeg %s]: %s", req.ID, msg))
					}
				}
				if err != nil { break }
			}
		}()

		if err := cmd.Start(); err != nil {
			c.JSON(500, gin.H{"error": "Spawn failed"})
			return
		}

		activeHlsProcesses.Store(req.ID, cmd)

		go func() {
			_ = cmd.Wait()
			customLog(fmt.Sprintf("🛑 Стрим %s остановлен", req.ID))
			activeHlsProcesses.Delete(req.ID)
		}()

		c.JSON(200, gin.H{"success": true, "url": fmt.Sprintf("/streams/%s/index.m3u8", req.ID)})
	})

	r.POST("/api/hls/stop", func(c *gin.Context) {
		var req struct{ ID string `json:"id"` }
		_ = c.ShouldBindJSON(&req)
		if proc, ok := activeHlsProcesses.Load(req.ID); ok {
			_ = proc.(*exec.Cmd).Process.Kill()
			c.JSON(200, gin.H{"success": true})
		} else {
			c.JSON(200, gin.H{"success": false})
		}
	})

	r.GET("/api/fix-video", func(c *gin.Context) {
		inputPath := "offline.mp4"
		outputPath := "offline_fixed.mp4"

		args := []string{"-y", "-i", inputPath, "-c:v", "libx264", "-preset", "fast", "-c:a", "aac", "-movflags", "+faststart", outputPath}
		cmd := exec.Command(ffmpegPath, args...)
		
		err := cmd.Run()
		if err != nil {
			c.String(500, "Ошибка конвертации")
			return
		}
		_ = os.Chmod(outputPath, 0644)
		c.Header("Content-Type", "text/html")
		c.String(200, "<h1>Успех!</h1><p>Видео перекодировано.</p>")
	})

	videoHandler := func(c *gin.Context) {
		videoPath := "offline_fixed.mp4"
		if _, err := os.Stat(videoPath); os.IsNotExist(err) {
			videoPath = "offline.mp4"
		}
		if _, err := os.Stat(videoPath); os.IsNotExist(err) {
			c.Status(404)
			return
		}
		c.File(videoPath)
	}

	r.GET("/api/video/offline", videoHandler)
	r.GET("/offline.mp4", videoHandler)
}


func setupFCMRoutes(r *gin.Engine) {
	r.POST("/api/fcm/subscribe", func(c *gin.Context) {
		var req struct {
			RpiID    string `json:"rpi_id"`
			FCMToken string `json:"fcm_token"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Missing rpi_id or fcm_token"})
			return
		}

		tokens, _ := readCSV("fcm_tokens")
		exists := false
		for _, t := range tokens {
			if t["rpi_id"] == req.RpiID && t["token"] == req.FCMToken {
				exists = true
				break
			}
		}

		if !exists {
			location := time.FixedZone("UTC+5", 5*60*60)
			err := writeCSV("fcm_tokens", map[string]string{
				"rpi_id":     req.RpiID,
				"token":      req.FCMToken,
				"updated_at": time.Now().In(location).Format(time.RFC3339),
			})
			if err != nil {
				c.JSON(500, gin.H{"error": "Failed to save token"})
				return
			}
			customLog("✅ FCM Token сохранен для ", req.RpiID)
		} else {
			customLog("ℹ️ FCM Token уже существует для ", req.RpiID)
		}

		c.JSON(200, gin.H{"success": true})
	})

	r.DELETE("/api/fcm/subscribe", func(c *gin.Context) {
		var req struct {
			RpiID    string `json:"rpi_id"`
			FCMToken string `json:"fcm_token"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}

		tokens, _ := readCSV("fcm_tokens")
		var newTokens []map[string]string
		found := false
		for _, t := range tokens {
			if !(t["rpi_id"] == req.RpiID && t["token"] == req.FCMToken) {
				newTokens = append(newTokens, t)
			} else {
				found = true
			}
		}

		if found {
			rewriteCSV("fcm_tokens", []string{"rpi_id", "token", "updated_at"}, newTokens)
		}
		c.JSON(200, gin.H{"success": true})
	})
}

func sendFcmNotification(rpiID, title, body string) {
	if firebaseApp == nil {
		customLog("⚠️ Firebase не инициализирован")
		return
	}

	ctx := context.Background()
	client, err := firebaseApp.Messaging(ctx)
	if err != nil {
		customLog("❌ Ошибка клиента FCM: ", err)
		return
	}

	allTokens, _ := readCSV("fcm_tokens")
	var userTokens []string
	for _, t := range allTokens {
		if t["rpi_id"] == rpiID {
			userTokens = append(userTokens, t["token"])
		}
	}

	if len(userTokens) == 0 {
		return
	}

	customLog(fmt.Sprintf("📤 Отправка FCM пуша для %s на %d устройств", rpiID, len(userTokens)))

	for _, token := range userTokens {
		message := &messaging.Message{
			Notification: &messaging.Notification{
				Title: title,
				Body:  body,
			},
			Token: token,
		}

		_, err := client.Send(ctx, message)
		if err != nil {
			customLog(fmt.Sprintf("❌ Ошибка отправки на токен %s: %v", token, err))
			
		}
	}
}




func setupCameraRoutes(r *gin.Engine) {
	
	r.GET("/api/ip-cameras", func(c *gin.Context) {
		rpiID := c.Query("rpi_id")
		if rpiID == "" {
			c.JSON(400, gin.H{"error": "Missing rpi_id"})
			return
		}
		cams, _ := readCSV("ip_cameras")
		var userCams []map[string]string
		for _, cam := range cams {
			if cam["rpi_id"] == rpiID {
				userCams = append(userCams, cam)
			}
		}
		c.JSON(200, userCams)
	})

	
	r.POST("/api/ip-cameras", func(c *gin.Context) {
		var req struct {
			RpiID    string `json:"rpi_id"`
			Name     string `json:"name"`
			RtspFull string `json:"rtsp_full"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Missing fields"})
			return
		}

		newCam := map[string]string{
			"id":        uuid.New().String(),
			"rpi_id":    req.RpiID,
			"name":      req.Name,
			"rtsp_full": req.RtspFull,
		}

		if err := writeCSV("ip_cameras", newCam); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"success": true})
	})

	
	r.DELETE("/api/ip-cameras/:id", func(c *gin.Context) {
		id := c.Param("id")
		cams, _ := readCSV("ip_cameras")
		
		var newCams []map[string]string
		found := false
		for _, cam := range cams {
			if cam["id"] != id {
				newCams = append(newCams, cam)
			} else {
				found = true
			}
		}

		if found {
			headers := []string{"id", "rpi_id", "name", "rtsp_full"}
			rewriteCSV("ip_cameras", headers, newCams)
		}
		c.JSON(200, gin.H{"success": true})
	})

	
	r.POST("/api/ip-camera/record", func(c *gin.Context) {
		var req struct {
			ID      string `json:"id"`
			Seconds int    `json:"seconds"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}

		cams, _ := readCSV("ip_cameras")
		var cam map[string]string
		for _, v := range cams {
			if v["id"] == req.ID { cam = v; break }
		}

		if cam == nil {
			c.JSON(404, gin.H{"error": "Камера не найдена"})
			return
		}

		folder := filepath.Join("users_videos", req.ID)
		_ = os.MkdirAll(folder, 0777)

		
		location := time.FixedZone("UTC+5", 5*60*60)
		timestamp := time.Now().In(location).Format("2006-01-02_15-04-05")
		filename := fmt.Sprintf("%s_%s.mp4", req.ID, timestamp)
		filepath := filepath.Join(folder, filename)
		
		duration := "10"
		if req.Seconds > 0 {
			duration = fmt.Sprintf("%d", req.Seconds)
		}

		customLog(fmt.Sprintf("🎥 Запуск записи RTSP: %s на %s сек", cam["name"], duration))

		
		go func() {
			cmd := exec.Command(ffmpegPath, 
				"-y", 
				"-i", cam["rtsp_full"], 
				"-t", duration, 
				"-c", "copy", 
				"-v", "error", 
				filepath,
			)
			output, _ := cmd.CombinedOutput()
			if len(output) > 0 {
				customLog(fmt.Sprintf("[FFmpeg Rec Error]: %s", string(output)))
			}
			customLog(fmt.Sprintf("✅ Запись завершена для %s", cam["name"]))
		}()

		c.JSON(200, gin.H{"success": true, "message": "Recording started"})
	})
}


type PushSubscription struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}


type SubscribeRequest struct {
	RpiID        string           `json:"rpi_id"`
	Subscription PushSubscription `json:"subscription"`
}

func setupWebPushRoutes(r *gin.Engine) {

	
	r.GET("/api/generate-vapid", func(c *gin.Context) {
		privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{
			"publicKey":  publicKey,
			"privateKey": privateKey,
		})
	})

	
	r.GET("/api/push/key", func(c *gin.Context) {
		c.JSON(200, gin.H{"publicKey": publicVapidKey})
	})

	
	r.POST("/api/subscribe", func(c *gin.Context) {
		var req SubscribeRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			customLog("Ошибка: Невалидная подписка")
			c.JSON(400, gin.H{"error": "Invalid subscription"})
			return
		}

		customLog("--- ПОПЫТКА ПОДПИСКИ ---")
		customLog("RPI ID: " + req.RpiID)

		if req.RpiID == "" {
			customLog("Ошибка: Нет rpi_id")
			c.JSON(400, gin.H{"error": "Missing rpi_id"})
			return
		}

		
		data := map[string]string{
			"rpi_id":   req.RpiID,
			"endpoint": req.Subscription.Endpoint,
			"p256dh":   req.Subscription.Keys.P256dh,
			"auth":     req.Subscription.Keys.Auth,
		}

		if err := writeCSV("subs", data); err != nil {
			customLog("❌ Ошибка записи в subs.csv: " + err.Error())
			c.JSON(500, gin.H{"error": "Failed to write to file"})
			return
		}

		customLog("✅ Подписка успешно сохранена в subs.csv")
		c.JSON(200, gin.H{"success": true})
	})
}


func sendPushNotification(rpiID, title, body string) {
	subs, err := readCSV("subs")
	if err != nil {
		return
	}

	
	payload := fmt.Sprintf(`{"title":"%s", "body":"%s"}`, title, body)

	for _, sub := range subs {
		if sub["rpi_id"] == rpiID {
			
			s := &webpush.Subscription{
				Endpoint: sub["endpoint"],
				Keys: webpush.Keys{
					P256dh: sub["p256dh"],
					Auth:   sub["auth"],
				},
			}

			
			resp, err := webpush.SendNotification([]byte(payload), s, &webpush.Options{
				Subscriber:      "mailto:admin@ecodom.asia",
				VAPIDPublicKey:  publicVapidKey,
				VAPIDPrivateKey: privateVapidKey,
				TTL:             30,
			})

			if err != nil {
				customLog(fmt.Sprintf("Push error for %s: %v", rpiID, err))
			} else {
				defer resp.Body.Close()
			}
		}
	}
}


func getLang(chatID int64) string {
	tgUsers, _ := readCSV("tg")
	sID := fmt.Sprintf("%d", chatID)
	for _, u := range tgUsers {
		if u["chat_id"] == sID {
			if lang, ok := u["lang"]; ok && lang != "" { return lang }
		}
	}
	return "ru"
}

func getUserRpi(chatID int64) string {
	tgUsers, _ := readCSV("tg")
	sID := fmt.Sprintf("%d", chatID)
	for _, u := range tgUsers {
		if u["chat_id"] == sID { return u["rpi_id"] }
	}
	return ""
}

func getMainMenu(lang string) tgbotapi.InlineKeyboardMarkup {
	d := getD(lang)
	return tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData(d["btn_sensors"], "menu_sensors"),
			tgbotapi.NewInlineKeyboardButtonData(d["btn_devices"], "menu_devices"),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData(d["btn_settings"], "menu_settings"),
			tgbotapi.NewInlineKeyboardButtonData(d["btn_wifi"], "menu_wifi"),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData(d["btn_lang"], "menu_lang"),
		),
	)
}

func stopMonitor(chatID int64) {
	if cancel, ok := activeMonitors.Load(chatID); ok {
		cancel.(context.CancelFunc)()
		activeMonitors.Delete(chatID)
	}
}


func initTelegramBot() {
	token := os.Getenv("tg")
	if token == "" || token == "ничего" {
		customLog("⚠️ Telegram Bot Token missing. Bot not started.")
		return
	}

	var err error
	bot, err = tgbotapi.NewBotAPI(token)
	if err != nil {
		customLog("❌ Telegram Error: " + err.Error())
		return
	}

	customLog("🤖 Telegram Bot started: " + bot.Self.UserName)

	u := tgbotapi.NewUpdate(0)
	u.Timeout = 60
	updates := bot.GetUpdatesChan(u)

	for update := range updates {
		if update.Message != nil {
			handleMessage(update.Message)
		} else if update.CallbackQuery != nil {
			handleCallback(update.CallbackQuery)
		}
	}
}

func handleMessage(msg *tgbotapi.Message) {
	chatID := msg.Chat.ID
	text := msg.Text

	
	if stateData, ok := userStates.Load(chatID); ok {
		handleStateMessage(msg, stateData.(map[string]string))
		return
	}

	
	if strings.HasPrefix(text, "/start") {
		payload := strings.TrimSpace(strings.TrimPrefix(text, "/start"))
		if payload != "" {
			decoded, _ := url.QueryUnescape(payload)
			parts := strings.Split(decoded, "_")
			if len(parts) >= 2 {
				rpiID, password := parts[0], parts[1]
				lang := "ru"
				if len(parts) > 2 { lang = parts[2] }

				users, _ := readCSV("users")
				var validUser bool
				for _, u := range users {
					if u["rpi_id"] == rpiID && u["password"] == password {
						validUser = true; break
					}
				}

				if validUser {
					tgUsers, _ := readCSV("tg")
					sChatID := fmt.Sprintf("%d", chatID)
					found := false
					for _, u := range tgUsers {
						if u["chat_id"] == sChatID { found = true; break }
					}

					newRow := map[string]string{
						"rpi_id": rpiID, "chat_id": sChatID, "lang": lang,
						"username": msg.From.UserName, "last_seen": time.Now().Format(time.RFC3339),
					}

					if found {
						rewriteCSV("tg", []string{"rpi_id", "username", "chat_id", "last_seen", "lang"}, []map[string]string{newRow})
					} else {
						writeCSV("tg", newRow)
					}
					
					d := getD(lang)
					m := tgbotapi.NewMessage(chatID, d["auth_success"]+"\nID: "+rpiID)
					m.ReplyMarkup = getMainMenu(lang)
					bot.Send(m)
				} else {
					bot.Send(tgbotapi.NewMessage(chatID, getD("ru")["auth_fail"]))
				}
			}
		} else {
			
			rpiID := getUserRpi(chatID)
			lang := getLang(chatID)
			if rpiID != "" {
				m := tgbotapi.NewMessage(chatID, getD(lang)["welcome"])
				m.ReplyMarkup = getMainMenu(lang)
				bot.Send(m)
			} else {
				bot.Send(tgbotapi.NewMessage(chatID, "Please login via website first."))
			}
		}
	}
}

func handleCallback(query *tgbotapi.CallbackQuery) {
	chatID := query.Message.Chat.ID
	data := query.Data
	rpiID := getUserRpi(chatID)
	lang := getLang(chatID)
	d := getD(lang)

	if !strings.HasPrefix(data, "set_lang_") && rpiID == "" {
		bot.Send(tgbotapi.NewCallback(query.ID, "Auth required"))
		return
	}

	switch {
	case data == "menu_main":
		stopMonitor(chatID)
		msg := tgbotapi.NewEditMessageText(chatID, query.Message.MessageID, d["welcome"])
		markup := getMainMenu(lang)
		msg.ReplyMarkup = &markup
		bot.Send(msg)

	case data == "menu_sensors":
		stopMonitor(chatID)
		ctx, cancel := context.WithCancel(context.Background())
		activeMonitors.Store(chatID, cancel)
		go func() {
			ticker := time.NewTicker(3 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done(): return
				case <-ticker.C:
					sensors, _ := readCSV("sensor_data")
					var latest map[string]string
					for _, s := range sensors {
						if s["rpi_id"] == rpiID { latest = s } 
					}
					txt := "<b>" + d["current_data"] + "</b>\n"
					if latest != nil {
						txt += fmt.Sprintf("Temp: %s°C\nHum: %s%%\nCO: %sppm\nSolar: %sV\nWind: %sV\nBatt: %s%%\nMotion: %s\nTime: %s", 
							latest["temp"], latest["humidity"], latest["co_ppm"], latest["solar_voltage"], latest["wind_voltage"], latest["battery_level"], latest["motion"], latest["timestamp"])
					} else { txt += d["no_data"] }
					
					edit := tgbotapi.NewEditMessageText(chatID, query.Message.MessageID, txt)
					edit.ParseMode = "HTML"
					backBtn := tgbotapi.NewInlineKeyboardMarkup(tgbotapi.NewInlineKeyboardRow(tgbotapi.NewInlineKeyboardButtonData(d["back"], "menu_main")))
					edit.ReplyMarkup = &backBtn
					bot.Send(edit)
				}
			}
		}()

	case data == "menu_settings":
		stopMonitor(chatID)
		users, _ := readCSV("users")
		var user map[string]string
		for _, u := range users { if u["rpi_id"] == rpiID { user = u; break } }
		
		if user == nil { return }
		
		makeBtn := func(txt, field string) tgbotapi.InlineKeyboardButton {
			state := "❌ " + d["off"]
			if user[field] == "true" { state = "✅ " + d["on"] }
			return tgbotapi.NewInlineKeyboardButtonData(txt+": "+state, "toggle_"+field)
		}

		markup := tgbotapi.NewInlineKeyboardMarkup(
			tgbotapi.NewInlineKeyboardRow(makeBtn("Away Mode", "away_mode")),
			tgbotapi.NewInlineKeyboardRow(makeBtn("CO2 Alert", "co2_alert")),
			tgbotapi.NewInlineKeyboardRow(makeBtn("PIR Alert", "pir_alert")),
			tgbotapi.NewInlineKeyboardRow(makeBtn("Power Alert", "power_alert")),
			tgbotapi.NewInlineKeyboardRow(tgbotapi.NewInlineKeyboardButtonData("🔐 "+d["pass_change"], "change_pass_start")),
			tgbotapi.NewInlineKeyboardRow(tgbotapi.NewInlineKeyboardButtonData(d["back"], "menu_main")),
		)
		
		edit := tgbotapi.NewEditMessageText(chatID, query.Message.MessageID, d["settings_title"])
		edit.ReplyMarkup = &markup
		bot.Send(edit)

	case data == "change_pass_start":
		userStates.Store(chatID, map[string]string{"state": "waiting_new_pass", "rpi_id": rpiID})
		msg := tgbotapi.NewMessage(chatID, d["pass_enter"])
		msg.ReplyMarkup = tgbotapi.ForceReply{ForceReply: true}
		bot.Send(msg)

	case strings.HasPrefix(data, "set_lang_"):
		newLang := strings.TrimPrefix(data, "set_lang_")
		
		updateCSVRecord("tg", "chat_id", fmt.Sprintf("%d", chatID), map[string]string{"lang": newLang})
		
		dNew := getD(newLang)
		m := tgbotapi.NewMessage(chatID, dNew["welcome"])
		m.ReplyMarkup = getMainMenu(newLang)
		bot.Send(m)
	}

	
	bot.Send(tgbotapi.NewCallback(query.ID, ""))
}

func handleStateMessage(msg *tgbotapi.Message, state map[string]string) {
	chatID := msg.Chat.ID
	lang := getLang(chatID)
	d := getD(lang)

	if state["state"] == "waiting_new_pass" {
		
		bot.Send(tgbotapi.NewMessage(chatID, d["pass_updated"]))
		userStates.Delete(chatID)
	}
}



func setupApiRoutes(r *gin.Engine) {

	
	r.POST("/api/login", func(c *gin.Context) {
		var req struct {
			RpiID    string `json:"rpi_id"`
			Password string `json:"password"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}

		users, _ := readCSV("users")
		var user map[string]string
		for _, u := range users {
			if u["rpi_id"] == req.RpiID {
				user = u
				break
			}
		}

		if user == nil {
			c.JSON(404, gin.H{"error": "Device not registered"})
			return
		}

		if user["password"] == req.Password {
			token := generateToken()
			ip := c.ClientIP()
			
			
			updateData := map[string]string{
				"global_ip": ip,
				"last_seen": time.Now().Add(5 * time.Hour).Format(time.RFC3339),
			}
			
			
			updateCSVRecord("users", "rpi_id", req.RpiID, updateData)
			
			customLog(fmt.Sprintf("вход успешен для %s с IP %s", req.RpiID, ip))
			c.JSON(200, gin.H{"status": "success", "token": token, "rpi_id": req.RpiID})
		} else {
			customLog(fmt.Sprintf("вход неудачен для %s с IP %s", req.RpiID, c.ClientIP()))
			c.JSON(401, gin.H{"error": "Invalid credentials"})
		}
	})

	
	r.POST("/devices", func(c *gin.Context) {
		var req struct {
			DeviceToken  string `json:"deviceToken"`
			RpiID        string `json:"rpi_id"`
			OS           string `json:"os"`
			BatteryLevel string `json:"battery_level"`
			IsCharging   string `json:"is_charging"`
			HasFlash     string `json:"has_flash"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Missing fields"})
			return
		}

		devices, _ := readCSV("devices")
		var existingDevice map[string]string
		for _, d := range devices {
			if d["token"] == req.DeviceToken {
				existingDevice = d
				break
			}
		}

		updateData := map[string]string{
			"last_seen":     time.Now().Add(5 * time.Hour).Format(time.RFC3339),
			"last_ip":       c.ClientIP(),
			"os":            req.OS,
			"battery_level": req.BatteryLevel,
			"is_charging":   req.IsCharging,
			"has_flash":     req.HasFlash,
		}

		if existingDevice != nil {
			var responseCommand interface{} = nil
			if existingDevice["pending_command"] != "" {
				responseCommand = gin.H{
					"command": existingDevice["pending_command"],
					"value":   existingDevice["pending_value"],
				}
				updateData["pending_command"] = ""
				updateData["pending_value"] = ""
			}
			updateCSVRecord("devices", "token", req.DeviceToken, updateData)
			
			
			for k, v := range updateData { existingDevice[k] = v }
			c.JSON(200, gin.H{
				"device": existingDevice, 
				"server_command": responseCommand,
			})
		} else {
			newDevice := map[string]string{
				"rpi_id":          req.RpiID,
				"token":           req.DeviceToken,
				"seconds":         "10",
				"video_count":     "0",
				"pending_command": "",
				"pending_value":   "",
			}
			for k, v := range updateData { newDevice[k] = v }
			writeCSV("devices", newDevice)
			c.JSON(200, newDevice)
		}
	})

	
	r.POST("/api/sensor_data", func(c *gin.Context) {
		rpiID := c.PostForm("rpi_id")
		if rpiID == "" { rpiID = c.Query("rpi_id") }
		
		
		if rpiID == "" {
			var tempReq struct { RpiID string `json:"rpi_id"` }
			c.ShouldBindJSON(&tempReq)
			rpiID = tempReq.RpiID
		}

		if rpiID == "" {
			c.JSON(400, gin.H{"error": "Missing rpi_id"})
			return
		}

		sensorRecord := map[string]string{
			"rpi_id":        rpiID,
			"temp":          c.PostForm("temp"),
			"humidity":      c.PostForm("humidity"),
			"co_ppm":        c.PostForm("co_ppm"),
			"solar_voltage": c.PostForm("solar_voltage"),
			"wind_voltage":  c.PostForm("wind_voltage"),
			"battery_level": c.PostForm("battery_level"),
			"motion":        c.PostForm("motion"),
			"timestamp":     time.Now().Add(5 * time.Hour).Format(time.RFC3339),
		}
		writeCSV("sensor_data", sensorRecord)

		
		users, _ := readCSV("users")
		var user map[string]string
		for _, u := range users { if u["rpi_id"] == rpiID { user = u; break } }

		if user != nil {
			isMotion := sensorRecord["motion"] == "true"

			
			if user["away_mode"] == "true" && isMotion {
				if canSendAlert(rpiID, "away_motion") {
					go sendPushNotification(rpiID, "🚨 ТРЕВОГА!", "Обнаружено движение в режиме 'Уход'!")
					go sendFcmNotification(rpiID, "🚨 ТРЕВОГА!", "Обнаружено движение в режиме 'Уход'!")
				}

				
				devices, _ := readCSV("devices")
				for _, dev := range devices {
					if dev["rpi_id"] == rpiID {
						updateCSVRecord("devices", "token", dev["token"], map[string]string{
							"pending_command": "record",
							"pending_value":   "10",
						})
					}
				}

				
				cams, _ := readCSV("ip_cameras")
				for _, cam := range cams {
					if cam["rpi_id"] == rpiID {
						go func(cam map[string]string) {
							folder := filepath.Join("users_videos", cam["id"])
							os.MkdirAll(folder, 0777)
							filename := fmt.Sprintf("%s_AUTO_%d.mp4", cam["id"], time.Now().Unix())
							filepath := filepath.Join(folder, filename)
							exec.Command(ffmpegPath, "-y", "-i", cam["rtsp_full"], "-t", "15", "-c", "copy", filepath).Run()
						}(cam)
					}
				}
			} else if user["pir_alert"] == "true" && isMotion {
				if canSendAlert(rpiID, "pir") {
					go sendPushNotification(rpiID, "Motion Detected", "Замечено движение.")
					go sendFcmNotification(rpiID, "👀 Движение обнаружено", "Замечено движение.")
				}
			}

			
			co2Val, _ := strconv.ParseFloat(sensorRecord["co_ppm"], 64)
			if user["co2_alert"] == "true" && co2Val > 1000 {
				if canSendAlert(rpiID, "co2") {
					msg := fmt.Sprintf("Уровень газа критический: %v ppm", co2Val)
					go sendPushNotification(rpiID, "⚠️ Высокий CO2", msg)
					go sendFcmNotification(rpiID, "⚠️ Высокий CO2", msg)
				}
			}
		}

		c.JSON(200, gin.H{"status": "success"})
	})
	
	
	r.GET("/api/wifi", func(c *gin.Context) {
		rpiID := c.Query("rpi_id")
		data, _ := readCSV("rpi")
		for _, conf := range data {
			if conf["rpi_id"] == rpiID {
				c.JSON(200, conf)
				return
			}
		}
		c.JSON(200, gin.H{})
	})
}


func setupWebInterfaceRoutes(r *gin.Engine) {

	
	r.GET("/api/user/settings", func(c *gin.Context) {
		rpiID := c.Query("rpi_id")
		users, _ := readCSV("users")
		
		for _, u := range users {
			if u["rpi_id"] == rpiID {
				c.JSON(200, gin.H{
					"away_mode":   u["away_mode"] == "true",
					"co2_alert":   u["co2_alert"] == "true",
					"pir_alert":   u["pir_alert"] == "true",
					"power_alert": u["power_alert"] == "true",
				})
				return
			}
		}
		c.JSON(404, gin.H{})
	})

	r.POST("/api/user/settings", func(c *gin.Context) {
		var req struct {
			RpiID   string      `json:"rpi_id"`
			Setting string      `json:"setting"`
			Value   interface{} `json:"value"` 
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}

		valStr := fmt.Sprintf("%v", req.Value) 
		success := updateCSVRecord("users", "rpi_id", req.RpiID, map[string]string{
			req.Setting: valStr,
		})

		c.JSON(200, gin.H{"success": success})
	})

	
	r.GET("/api/devices", func(c *gin.Context) {
		rpiID := c.Query("rpi_id")
		devices, _ := readCSV("devices")
		
		location := time.FixedZone("UTC+5", 5*60*60)
		now := time.Now().In(location)

		var processed []map[string]interface{}
		onlineCount := 0

		for _, d := range devices {
			if d["rpi_id"] != rpiID {
				continue
			}

			
			lastSeenTime, _ := time.Parse(time.RFC3339, d["last_seen"])
			diff := now.Sub(lastSeenTime).Seconds()

			
			isOnline := diff >= 0 && diff <= 5
			if isOnline {
				onlineCount++
			}

			
			devObj := make(map[string]interface{})
			for k, v := range d {
				devObj[k] = v
			}
			devObj["is_online"] = isOnline
			devObj["last_seen_seconds"] = int(diff)
			
			processed = append(processed, devObj)
		}

		c.JSON(200, gin.H{
			"devices": processed,
			"stats": gin.H{
				"total":   len(processed),
				"online":  onlineCount,
				"offline": len(processed) - onlineCount,
			},
		})
	})

	
	r.DELETE("/api/devices/:token", func(c *gin.Context) {
		token := c.Param("token")
		devices, _ := readCSV("devices")
		
		var newDevices []map[string]string
		var headers []string
		found := false

		if len(devices) > 0 {
			for k := range devices[0] {
				headers = append(headers, k)
			}
		}

		for _, d := range devices {
			if d["token"] != token {
				newDevices = append(newDevices, d)
			} else {
				found = true
			}
		}

		if found {
			rewriteCSV("devices", headers, newDevices)
			
			folder := filepath.Join("users_videos", token)
			os.RemoveAll(folder)
		}

		c.JSON(200, gin.H{"success": true})
	})

	
	r.GET("/api/latest_sensor_data", func(c *gin.Context) {
		rpiID := c.Query("rpi_id")
		data, _ := readCSV("sensor_data")
		
		var latest map[string]string
		var lastTime time.Time

		for _, d := range data {
			if d["rpi_id"] == rpiID {
				t, _ := time.Parse(time.RFC3339, d["timestamp"])
				if latest == nil || t.After(lastTime) {
					latest = d
					lastTime = t
				}
			}
		}

		if latest == nil {
			c.JSON(200, gin.H{})
		} else {
			c.JSON(200, latest)
		}
	})
}

func setupHistoryAndFilesRoutes(r *gin.Engine) {

	
	r.GET("/api/history", func(c *gin.Context) {
		rpiID := c.Query("rpi_id")
		sensor := c.Query("sensor") 
		daysStr := c.Query("days")
		
		days, _ := strconv.Atoi(daysStr)
		if days == 0 { days = 1 }

		data, _ := readCSV("sensor_data")
		
		
		threshold := time.Now().Add(time.Duration(-days*24) * time.Hour)
		
		type entry struct {
			Label string
			Value float64
			Time  time.Time
		}
		var filtered []entry

		for _, d := range data {
			if d["rpi_id"] != rpiID { continue }
			
			ts, _ := time.Parse(time.RFC3339, d["timestamp"])
			if ts.After(threshold) {
				val, _ := strconv.ParseFloat(d[sensor], 64)
				
				label := ts.Format("02.01.2006, 15:04:05")
				filtered = append(filtered, entry{Label: label, Value: val, Time: ts})
			}
		}

		
		sort.Slice(filtered, func(i, j int) bool {
			return filtered[i].Time.Before(filtered[j].Time)
		})

		
		var labels []string
		var values []float64
		for _, e := range filtered {
			labels = append(labels, e.Label)
			values = append(values, e.Value)
		}

		c.JSON(200, gin.H{
			"labels": labels,
			"values": values,
		})
	})

	
	r.POST("/upload", func(c *gin.Context) {
		token := c.GetHeader("devicetoken")
		if token == "" {
			c.JSON(400, gin.H{"error": "Missing devicetoken header"})
			return
		}

		file, err := c.FormFile("video")
		if err != nil {
			c.JSON(400, gin.H{"error": "No file uploaded"})
			return
		}

		
		dir := filepath.Join("users_videos", token)
		_ = os.MkdirAll(dir, 0777)

		
		ts := time.Now().Add(5 * time.Hour).Format("2006-01-02_15-04-05")
		filename := fmt.Sprintf("%s_%s.webm", token, ts)
		dst := filepath.Join(dir, filename)

		
		if err := c.SaveUploadedFile(file, dst); err != nil {
			c.JSON(500, gin.H{"error": "Failed to save file"})
			return
		}

		
		devices, _ := readCSV("devices")
		for _, d := range devices {
			if d["token"] == token {
				count, _ := strconv.Atoi(d["video_count"])
				newCount := strconv.Itoa(count + 1)
				updateCSVRecord("devices", "token", token, map[string]string{
					"video_count": newCount,
				})
				customLog(fmt.Sprintf("Видео получено от %s, всего: %s", token, newCount))
				break
			}
		}

		c.JSON(200, gin.H{"success": true})
	})


	
	r.GET("/api/device/videos/:token", func(c *gin.Context) {
		token := c.Param("token")
		folder := filepath.Join("users_videos", token)

		files, err := os.ReadDir(folder)
		if err != nil {
			c.JSON(200, []string{}) 
			return
		}

		type videoInfo struct {
			Name string    `json:"name"`
			Date time.Time `json:"date"`
			Size int64     `json:"size"`
		}
		var videos []videoInfo

		for _, f := range files {
			if !f.IsDir() && (strings.HasSuffix(f.Name(), ".webm") || strings.HasSuffix(f.Name(), ".mp4")) {
				info, _ := f.Info()
				videos = append(videos, videoInfo{
					Name: f.Name(),
					Date: info.ModTime(),
					Size: info.Size(),
				})
			}
		}

		
		sort.Slice(videos, func(i, j int) bool {
			return videos[i].Date.After(videos[j].Date)
		})

		c.JSON(200, videos)
	})

	
	r.GET("/api/video/:token/:file", func(c *gin.Context) {
		token := c.Param("token")
		fileName := c.Param("file")
		path := filepath.Join("users_videos", token, fileName)

		if c.Query("download") != "" {
			c.Header("Content-Description", "File Transfer")
			c.Header("Content-Transfer-Encoding", "binary")
			c.Header("Content-Disposition", "attachment; filename="+fileName)
			c.Header("Content-Type", "application/octet-stream")
			c.File(path)
		} else {
			c.File(path)
		}
	})
}


func setupFinalRoutes(r *gin.Engine) {
	
	r.POST("/api/change_password", func(c *gin.Context) {
		var req struct {
			RpiID       string `json:"rpi_id"`
			OldPassword string `json:"old_password"`
			NewPassword string `json:"new_password"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}

		users, _ := readCSV("users")
		found := false
		for _, u := range users {
			if u["rpi_id"] == req.RpiID && u["password"] == req.OldPassword {
				found = true
				break
			}
		}

		if !found {
			c.JSON(401, gin.H{"error": "Wrong password"})
			return
		}

		updateCSVRecord("users", "rpi_id", req.RpiID, map[string]string{"password": req.NewPassword})
		customLog(fmt.Sprintf("Пароль изменен для юзера %s на %s, ip: %s", req.RpiID, req.NewPassword, c.ClientIP()))
		c.JSON(200, gin.H{"status": "success"})
	})

	
	r.POST("/api/heartbeat", func(c *gin.Context) {
		var req struct { RpiID string `json:"rpi_id"` }
		c.ShouldBindJSON(&req)
		
		if req.RpiID != "" {
			updateCSVRecord("users", "rpi_id", req.RpiID, map[string]string{
				"last_seen": time.Now().Add(5 * time.Hour).Format(time.RFC3339),
			})
		}
		c.JSON(200, gin.H{"status": "ok"})
	})
}








