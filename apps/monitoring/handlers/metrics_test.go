package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/panarastudios/panara-cloud/apps/monitoring/database"
)

var start = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

func testApp(t *testing.T, readings int) *fiber.App {
	t.Helper()
	db, err := database.OpenDB(filepath.Join(t.TempDir(), "monitoring.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for i := 0; i < readings; i++ {
		err := db.SaveMetric(database.ServerMetric{
			Timestamp: start.Add(time.Duration(i) * time.Minute).Format(time.RFC3339Nano),
			CPU:       float64(i), CPUCores: 2,
			MemUsed: 50, MemUsedGB: 4, MemTotal: 8, DiskUsed: 30, TotalDisk: 80,
			NetworkIn: float64(i * 60), NetworkOut: float64(i * 6),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	app := fiber.New()
	app.Get("/metrics", ServerMetrics(db))
	return app
}

func get(t *testing.T, app *fiber.App, query string) (int, []byte) {
	t.Helper()
	response, err := app.Test(httptest.NewRequest("GET", "/metrics"+query, nil))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, body
}

func TestLimitStillAnswersAnArrayOfReadings(t *testing.T) {
	app := testApp(t, 120)
	for query, want := range map[string]int{"": 50, "?limit=10": 10, "?limit=all": 120, "?limit=nonsense": 50} {
		status, body := get(t, app, query)
		var rows []map[string]any
		if err := json.Unmarshal(body, &rows); err != nil || status != 200 {
			t.Fatalf("%q: status %d, %v: %s", query, status, err, body)
		}
		if len(rows) != want {
			t.Errorf("%q: %d rows, want %d", query, len(rows), want)
		}
	}
	_, body := get(t, app, "?limit=2")
	var rows []map[string]any
	json.Unmarshal(body, &rows)
	// Oldest first, numbers as the two-decimal strings they have always been.
	if rows[0]["cpu"] != "118.00" || rows[1]["cpu"] != "119.00" || rows[1]["networkIn"] != "7140.00" {
		t.Errorf("rows: %s", body)
	}
	if rows[1]["timestamp"] != "2026-11-01T01:59:00Z" {
		t.Errorf("timestamp: %v", rows[1]["timestamp"])
	}
}

func TestRangeAnswersBuckets(t *testing.T) {
	app := testApp(t, 120)
	from, to := start.Unix(), start.Add(2*time.Hour).Unix()
	// A caller unsure of the collector's version sends `limit` too.
	for _, query := range []string{
		fmt.Sprintf("?from=%d&to=%d&step=1800", from, to),
		fmt.Sprintf("?from=%d&to=%d&step=1800&limit=120", from, to),
		"?from=2026-11-01T00:00:00Z&to=2026-11-01T02:00:00Z&step=1800",
		"?from=2026-11-01T05:30:00%2B05:30&to=2026-11-01T07:30:00%2B05:30&step=1800",
	} {
		status, body := get(t, app, query)
		var result database.BucketedMetrics
		if err := json.Unmarshal(body, &result); err != nil || status != 200 {
			t.Fatalf("%q: status %d, %v: %s", query, status, err, body)
		}
		if len(result.Buckets) != 4 || result.From != float64(from) || result.To != float64(to) || result.Step != 1800 {
			t.Fatalf("%q: %s", query, body)
		}
		second := result.Buckets[1]
		if second.Start != float64(from+1800) || second.Count != 30 || second.CPU.Avg != 44.5 || second.CPU.Max != 59 {
			t.Errorf("%q: second bucket %+v", query, second)
		}
		if second.NetworkIn == nil || second.NetworkIn.Max != 1 {
			t.Errorf("%q: rate %+v", query, second.NetworkIn)
		}
		if result.Latest == nil || result.Latest.CPU != 119 || result.Latest.Timestamp != "2026-11-01T01:59:00Z" {
			t.Errorf("%q: latest %+v", query, result.Latest)
		}
	}
}

func TestBadRangesAreRefused(t *testing.T) {
	app := testApp(t, 5)
	from, to := start.Unix(), start.Add(time.Hour).Unix()
	for _, query := range []string{
		fmt.Sprintf("?from=%d&to=%d", from, to),
		fmt.Sprintf("?from=%d&step=60", from),
		fmt.Sprintf("?to=%d&step=60", to),
		fmt.Sprintf("?from=%d&to=%d&step=0", from, to),
		fmt.Sprintf("?from=%d&to=%d&step=1.5", from, to),
		fmt.Sprintf("?from=%d&to=%d&step=60", to, from),
		fmt.Sprintf("?from=yesterday&to=%d&step=60", to),
		fmt.Sprintf("?from=NaN&to=%d&step=60", to),
		fmt.Sprintf("?from=%d&to=%d&step=1", from, from+86400*30),
	} {
		status, body := get(t, app, query)
		var answer map[string]string
		if status != 400 || json.Unmarshal(body, &answer) != nil || answer["error"] == "" {
			t.Errorf("%q: status %d: %s", query, status, body)
		}
	}
}
