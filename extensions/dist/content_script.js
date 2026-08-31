// PureBeat Core - content script của bản không giao diện.
// Việc duy nhất của nó: chèn phần lõi vào trang Spotify trước khi UI kịp dựng,
// và đẩy quy tắc chặn riêng (nếu có trong storage) xuống cho phần lõi dùng.
// Không popup, không badge, không thống kê, không gửi/nhận tin nhắn gì cả.

// Chèn đúng một file duy nhất chứa toàn bộ logic chặn.
var s = document.createElement('script');
s.src = chrome.runtime.getURL('injected/main.js');
s.onload = function () {
	s.remove(); // chèn xong thì tự dọn, đỡ để rác trong DOM
};
(document.head || document.documentElement).appendChild(s);

// Đẩy quy tắc chặn riêng xuống phần lõi. Bản Core không có màn hình nào để sửa
// quy tắc, nhưng nếu trong storage có sẵn (hoặc người dùng tự chỉnh qua công cụ
// khác) thì phần lõi vẫn dùng được.
function dayQuyTac() {
	chrome.storage.local.get({ quyTac: {} }, function (dl) {
		document.dispatchEvent(new CustomEvent('purebeatRules', { detail: dl.quyTac || {} }));
	});
}
dayQuyTac();

// Storage đổi là đẩy lại ngay, không cần tải lại trang.
chrome.storage.onChanged.addListener(function (thayDoi) {
	if (thayDoi.quyTac) dayQuyTac();
});