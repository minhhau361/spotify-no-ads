// PureBeat - phần lõi chạy bên trong trang Spotify Web Player.
//
// Ý tưởng chặn quảng cáo giống các bản trước: Spotify điều khiển việc phát nhạc
// qua một "state machine" nhận về từ fetch và websocket. Track quảng cáo có URI
// chứa ':ad:'. Mình can thiệp vào dữ liệu đó trước khi nó tới tay player để
// nhảy cóc qua quảng cáo, không cần đợi quảng cáo phát rồi mới skip.
//
// Mọi thứ nằm gọn trong một file này: hook fetch, hook websocket và phần xử lý
// state machine. Không dùng thư viện ngoài, không quét DOM liên tục, không vẽ
// gì lên trang - nhẹ hơn nhiều, máy yếu cũng chạy mượt.
(function () {
	'use strict';

	// Nếu lỡ bị chèn hai lần thì thôi, chỉ cần hook một lần là đủ.
	if (window.__purebeatActive) return;
	window.__purebeatActive = true;

	// Giữ lại fetch gốc để các request riêng của extension không tự dính hook.
	var originalFetch = window.fetch;

	// Thông tin cần thiết lấy nhàn từ request của chính Spotify, không phải
	// đi lấy token riêng lẻ gì cả.
	var deviceId = '';
	var accessToken = '';
	var clientToken = '';
	var authorizationHeader = '';

	var totalAdsRemoved = 0;

	// Ghi nhớ những state đã bị mình đụng tới, dùng để biết quảng cáo nào
	// thực sự bị bỏ qua khi tới lượt phát.
	var tamperedStatesMap = {};

	// Tránh hiện cảnh báo lặp đi lặp lại làm phiền người dùng.
	var lanCanhBaoGanNhat = 0;

	// Quy tắc chặn riêng do người dùng tự thêm trong popup. Mỗi quy tắc là một
	// đoạn mã nhỏ nhận track và trả về true nếu muốn chặn. Popup lưu vào
	// chrome.storage, content script đẩy xuống đây qua sự kiện purebeatRules.
	var quyTac = { audio: [], inject: [] };
	var quyTacDaBienDich = { audio: [], inject: [] };

	document.addEventListener('purebeatRules', function (e) {
		var moi = e.detail || {};
		quyTac.audio = Array.isArray(moi.audio) ? moi.audio : [];
		quyTac.inject = Array.isArray(moi.inject) ? moi.inject : [];
		bienDichQuyTac();
	});

	// Biên dịch sẵn một lượt khi quy tắc thay đổi, đỡ phải new Function liên tục.
	function bienDichQuyTac() {
		['audio', 'inject'].forEach(function (loai) {
			quyTacDaBienDich[loai] = [];
			quyTac[loai].forEach(function (maNguon) {
				try {
					quyTacDaBienDich[loai].push(new Function('track', maNguon));
				} catch (e) {
					// Quy tắc sai cú pháp thì bỏ qua, đừng để nó làm sập cả trang.
				}
			});
		});
	}

	// Chạy lần lượt các quy tắc của một loại, cái nào khớp là chặn luôn.
	function khopQuyTac(track, loai) {
		var danhSach = quyTacDaBienDich[loai];
		if (!danhSach || !danhSach.length) return false;
		for (var i = 0; i < danhSach.length; i++) {
			try {
				if (danhSach[i](track)) return true;
			} catch (e) {
				// Quy tắc lỗi lúc chạy thì coi như không khớp, vẫn nghe nhạc bình thường.
			}
		}
		return false;
	}

	// Mình thay thế window.fetch bằng bản của mình. Chỉ những request thật sự
	// liên quan tới hàng đợi phát nhạc mới bị xử lý sâu, còn lại đi qua nguyên xi.
	window.fetch = function (url, init) {
		url = typeof url === 'string' ? url : String(url);

		// Đây là request điều khiển state machine - chỗ chính để bỏ quảng cáo.
		if (url.indexOf('/state') !== -1) {
			// Nhân tiện lưu token xác thực để dùng cho các request riêng của extension.
			try {
				if (init && init.headers) {
					if (init.headers.authorization) authorizationHeader = init.headers.authorization;
					if (init.headers['client-token']) clientToken = init.headers['client-token'];
				}
			} catch (e) {}

			// Spotify có kiểu nhảy sang state machine ở tương lai qua state_id dạng
			// "future_xxx+id+state" hoặc "_future_+id+state". Mình tách lại thành id
			// riêng cho đúng chỗ nó cần. Lưu ý phải khớp cả tiền tố _future_ giống
			// bản gốc, nếu chỉ khớp đầu chuỗi thì flow này hỏng và player báo lỗi
			// "không thể phát nội dung này".
			var request = null;
			try { request = JSON.parse(init.body); } catch (e) {}
			if (request && request.state_ref && typeof request.state_ref.state_id === 'string'
				&& request.state_ref.state_id.indexOf('future_') !== -1) {
				var parts = request.state_ref.state_id.split('+');
				request.state_ref.state_machine_id = parts[1];
				request.state_ref.state_id = parts[2];
				init.body = JSON.stringify(request);
			}

			return originalFetch.call(window, url, init).then(function (response) {
				return boQuangCaoTrongResponse(response);
			});
		}

		// Request khai báo thiết bị, cần device_id khi mình tự hỏi máy chủ về state kế tiếp.
		if (url.lastIndexOf('/devices') === url.length - '/devices'.length) {
			try {
				var reqDevice = JSON.parse(init.body);
				deviceId = reqDevice.device.device_id;
			} catch (e) {}
			return originalFetch.call(window, url, init);
		}

		// Token truy cập, lưu lại phòng khi cần gọi riêng.
		if (url.indexOf('get_access_token') !== -1) {
			return originalFetch.call(window, url, init).then(function (response) {
				// Đọc bản clone để không ăn mất body mà trang Spotify cần đọc sau đó.
				response.clone().json().then(function (data) {
					if (data && data.accessToken) accessToken = data.accessToken;
				}).catch(function () {});
				return response;
			});
		}

		// Request xin license phát nhạc. Nếu trả 429 nghĩa là mình nhảy bài nhanh quá.
		if (url.indexOf('/license') !== -1) {
			return originalFetch.call(window, url, init).then(function (response) {
				if (response.status === 429) {
					canhBao('Spotify đang giới hạn vì nhảy bài quá nhanh. Nghỉ một lát rồi nghe tiếp nhé.');
				}
				return response;
			});
		}

		// Các request còn lại không liên quan, cho đi thẳng luôn cho nhanh.
		return originalFetch.call(window, url, init);
	};

	// Bọc lại hàm json() của response để hớt quảng cáo đúng lúc Spotify đọc dữ liệu.
	// Cách này không cần clone response nên tiết kiệm bộ nhớ hơn.
	function boQuangCaoTrongResponse(response) {
		var jsonGoc = response.json.bind(response);
		response.json = function () {
			return jsonGoc().then(async function (data) {
				try {
					if (data.commands) {
						// Với /state_conflict dữ liệu nằm gọn trong từng lệnh.
						for (var key in data.commands) {
							var lenh = data.commands[key];
							if (lenh && lenh.state_machine && lenh.state_ref) {
								lenh.state_machine = await xuLyStateMachine(
									lenh.state_machine, lenh.state_ref.state_index, false);
							}
						}
					} else if (data.state_machine && data.updated_state_ref) {
						data.state_machine = await xuLyStateMachine(
							data.state_machine, data.updated_state_ref.state_index, false);
					}
				} catch (e) {
					// Dù có lỗi cũng phải trả dữ liệu về cho trang, không được làm treo player.
				}
				return data;
			});
		};
		return response;
	}

	// Hook WebSocket. Spotify nhận lệnh phát nhạc thời gian thực qua socket này,
	// ví dụ như giữa chừng nó rót thêm quảng cáo vào hàng đợi.
	// Khác bản gốc là mình xử lý gần như đồng bộ, không bọc Promise vô nghĩa,
	// và tin nào không dính tới quảng cáo thì trả nguyên chuỗi gốc, đỡ một lần
	// JSON.stringify rất tốn kém.
	var NativeWebSocket = window.WebSocket;

	function HookedWebSocket(url, protocols) {
		var ws = protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);

		var onmessageCuaTrang = null;
		// Hàng đợi xử lý tuần tự để tin nhắn vẫn tới tay trang Spotify đúng thứ tự.
		var hangDoi = Promise.resolve();

		ws.addEventListener('message', function (event) {
			var hamNhan = onmessageCuaTrang;
			if (!hamNhan) return; // trang chưa gắn bộ nhận tin thì mình cũng chưa có việc gì làm

			hangDoi = hangDoi.then(function () {
				return locTinNhan(event.data).then(function (dataMoi) {
					if (dataMoi === null) {
						hamNhan.call(ws, event); // tin không liên quan quảng cáo, đưa nguyên bản
					} else {
						hamNhan.call(ws, new MessageEvent('message', { data: dataMoi }));
					}
				});
			}).catch(function () {
				// Có lỗi cũng phải đưa tin gốc đi, tuyệt đối không làm mất tin của player.
				hamNhan.call(ws, event);
			});
		});

		// Spotify gắn bộ nhận tin qua ws.onmessage, mình chặn đúng điểm này để lọc
		// tin trước khi nó kịp thấy. Trang vẫn đọc được giá trị như bình thường.
		Object.defineProperty(ws, 'onmessage', {
			set: function (fn) { onmessageCuaTrang = fn; },
			get: function () { return onmessageCuaTrang; },
			configurable: true
		});

		// Trả về socket thật nên mọi thao tác khác trên nó vẫn hoạt động như cũ.
		return ws;
	}
	HookedWebSocket.prototype = NativeWebSocket.prototype;
	HookedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
	HookedWebSocket.OPEN = NativeWebSocket.OPEN;
	HookedWebSocket.CLOSING = NativeWebSocket.CLOSING;
	HookedWebSocket.CLOSED = NativeWebSocket.CLOSED;
	window.WebSocket = HookedWebSocket;

	// Lọc một tin nhắn websocket. Trả về null nếu tin không cần sửa, ngược lại
	// trả về chuỗi JSON đã được làm sạch quảng cáo.
	async function locTinNhan(rawData) {
		if (typeof rawData !== 'string') return null;

		// Lọc thô bằng tìm chuỗi trước khi parse. Chỉ khi tin có dấu hiệu liên quan
		// tới quảng cáo mình mới tốn công JSON.parse, còn lại đi qua gần như miễn phí.
		if (rawData.indexOf('replace_state') === -1 && rawData.indexOf('ads/inject_tracks') === -1) {
			return null;
		}

		var data;
		try { data = JSON.parse(rawData); } catch (e) { return null; }
		if (!data || !data.payloads) return null;

		var coThayDoi = false;

		for (var i = 0; i < data.payloads.length; i++) {
			var payload = data.payloads[i];
			if (!payload) continue;

			if (payload.type === 'replace_state' && payload.state_machine && payload.state_ref) {
				payload.state_machine = await xuLyStateMachine(
					payload.state_machine, payload.state_ref.state_index, true);
				coThayDoi = true;
			} else if (payload.cluster && payload.update_reason === 'DEVICE_STATE_CHANGED') {
				var playerState = payload.cluster.player_state;
				// Spotify rót quảng cáo vào hàng đợi từ máy chủ, mình xóa trắng track đó đi.
				// Ngoài provider của Spotify, quy tắc chặn riêng của người dùng cũng có tác dụng.
				if (playerState && playerState.track
					&& (playerState.track.provider === 'ads/inject_tracks' || khopQuyTac(playerState.track, 'inject'))) {
					data.payloads[i] = null;
					coThayDoi = true;
					// Ghi luôn vào thống kê, đây là loại quảng cáo "chèn vào hàng đợi".
					var qcRot = playerState.track.metadata || {};
					baoQuangCaoBiChan(qcRot.uri || 'spotify:ad:khong-ro', 'strip',
						qcRot.advertiser || qcRot.name, 'inject');
				}
			}
		}

		if (!coThayDoi) return null; // không đổi gì thì dùng chuỗi gốc, tiết kiệm một lần stringify
		return JSON.stringify(data);
	}


	// Phần quan trọng nhất: dọn quảng cáo khỏi state machine.
	// Bỏi qua toàn bộ các state, gặp state nào là quảng cáo thì trỏ nó sang
	// state thật kế tiếp. Làm đi làm lại cho tới khi trong máy không còn quảng cáo.
	async function xuLyStateMachine(sm, startingIndex, isReplacing) {
		if (!sm || !sm.states || !sm.tracks) return sm;

		var conQuangCao = true;
		while (conQuangCao) {
			conQuangCao = false;

			for (var i = 0; i < sm.states.length; i++) {
				var state = sm.states[i];
				if (!state) continue;

				var track = sm.tracks[state.track];
				if (!track || !isAd(state, sm)) continue;

				// Mỗi state tự xử lý trong try riêng: một state gặp lỗi thì giữ nguyên
				// state đó, không được làm vỡ cả state machine khiến player báo
				// "không thể phát nội dung này".
				try {
					var trackURI = track.metadata.uri;

					// Tìm state thật đứng ngay sau quảng cáo này.
					var newState = getNextAdFreeState(sm, state.state_id, i);

					// Không còn state nào phía sau (quảng cáo cuối hàng đợi) thì không
					// có gì để trỏ sang, rút ngắn quảng cáo cho an toàn thay vì đẻ lỗi.
					if (!newState) {
						sm.states[i] = shortenedState(state, track);
						baoQuangCaoBiChan(trackURI, 'shorten', tenQuangCao(track), 'audio');
						continue;
					}

					if (isAd(newState, sm)) {
					// Quảng cáo nằm ngay cuối hàng đợi nên chưa thấy bài thật phía sau.
					// Phải hỏi máy chủ xin state machine xa hơn mới tìm được bài thật.
					try {
						var ketQua = await getNextAdFreeStateFromFutureStateMachine(sm, newState);
						if (ketQua[0]) {
							newState = ketQua[0];
							var futureSm = ketQua[1];
							// State mới nằm ở máy khác nên phải "ghép" lại cho vừa máy hiện tại.
							var fixed = fixStateForOldStateMachine(newState, futureSm, state.state_id, sm);
							newState = fixed[0];
							sm = fixed[1];
						} else {
							// Hết đường, đành rút ngắn quảng cáo về 0 giây cho nó lướt qua nhanh.
							sm.states[i] = shortenedState(state, track);
							baoQuangCaoBiChan(trackURI, 'shorten', tenQuangCao(track), 'audio');
							continue;
						}
					} catch (e) {
						sm.states[i] = shortenedState(state, track);
						baoQuangCaoBiChan(trackURI, 'shorten', tenQuangCao(track), 'audio');
						continue;
					}
				}

				// State mới bị khóa tua mà lại không có đường đi tiếp thì phải xin thêm state.
				if (newState.transitions && newState.transitions.advance === null
					&& newState.disallow_seeking === true) {
					var got = null;
					try { got = await getStates(sm.state_machine_id, newState.state_id); } catch (e) {}
					if (got && got[0]) {
						var fSm = got[0];
						newState = fSm.states[got[1].state_index];
						var fixed2 = fixStateForOldStateMachine(newState, fSm, state.state_id, sm);
						newState = fixed2[0];
						sm = fixed2[1];
					} else {
						// Không xin được thì mở khóa tay cho player tự đi tiếp.
						newState.disallow_seeking = false;
						newState.restrictions = {};
					}
				}

				if (state.state_id !== newState.state_id) {
					// Thành công: state quảng cáo giờ trỏ thẳng vào bài hát thật.
					var normId = getFutureStateId(newState.state_id);
					sm.states[i] = newState;
					tamperedStatesMap[normId] = trackURI;
					conQuangCao = true;
					baoQuangCaoBiChan(trackURI, 'jump', tenQuangCao(track), 'audio');
				} else {
					sm.states[i] = newState;
				}
				} catch (loiState) {
					// Lỗi ở một state thì bỏ qua state đó, tuyệt đối không để exception
					// bay lên làm hỏng toàn bộ state machine đang phát.
				}
			}
		}

		return sm;
	}

	// Duyệt lần lượt các state theo một loại chuyển tiếp (thường là 'advance').
	// Dùng generator cho gọn, quét hết rồi dừng, không đệ quy gì cả.
	function* duyetStates(states, startingIndex, tenChuyenTiep) {
		var state = states[startingIndex];
		var soVong = 0;
		while (state && soVong++ <= states.length + 2) {
			yield state;
			var chuyen = state.transitions && state.transitions[tenChuyenTiep];
			if (!chuyen) break;
			state = states[chuyen.state_index];
		}
	}

	// Từ một state cho trước, tìm state kế tiếp không phải quảng cáo.
	function getNextAdFreeState(sm, stateId, startingIndex) {
		var tracks = sm.tracks;
		var daThay = false;
		var state;

		for (state of duyetStates(sm.states, startingIndex, 'advance')) {
			if (daThay) {
				var track = tracks[state.track];
				if (track && isAdTrack(track)) continue; // vẫn là quảng cáo thì bỏ qua tiếp
				return state;
			}
			daThay = state.state_id === stateId;
		}

		return state; // chạy hết danh sách vẫn không thấy thì trả cái cuối cùng
	}

	// Khi phải xin state machine ở "tương lai" thì lần lượt đi tiếp cho tới khi
	// gặp state thật, tối đa vài lần thôi để khỏi làm phiền máy chủ.
	async function getNextAdFreeStateFromFutureStateMachine(sm, nextState) {
		var futureSm = sm;
		try {
			var soLan = 0;
			do {
				var smId = futureSm.state_machine_id;
				var stateId = nextState ? nextState.state_id : '';

				if (stateId && stateId.indexOf('future_') !== -1) {
					// Như bản gốc: khớp cả "_future_+...", sai chỗ này là player lỗi phát
					var parts = stateId.split('+');
					smId = parts[1];
					stateId = parts[2];
				}

				var got = await getStates(smId, stateId);
				if (!got || !got[0]) return [null, futureSm];
				futureSm = got[0];
				nextState = getNextAdFreeState(futureSm, stateId, 2);
				soLan++;
			} while (isAd(nextState, futureSm) && soLan < 5);

			if (isAd(nextState, futureSm)) return [null, futureSm];
		} catch (e) {
			return [null, futureSm];
		}
		return [nextState, futureSm];
	}


	// Ghép một state lấy từ state machine khác vào máy hiện tại cho đúng cấu trúc
	// mà player đang hiểu. Cần thiết khi mình nhảy sang "tương lai" để tìm bài thật.
	function fixStateForOldStateMachine(stateCanSua, futureSm, expectedStateId, sm) {
		var futureSmId = futureSm.state_machine_id;
		stateCanSua.state_id = '_future_+' + futureSmId + '+' + stateCanSua.state_id;

		// Đem track của state mới về máy hiện tại rồi trỏ chỉ số sang đó.
		var track = futureSm.tracks[stateCanSua.track];
		sm.tracks.push(track);
		stateCanSua.track = sm.tracks.length - 1;

		// Các state đi tiếp từ đây cũng phải làm tương tự.
		var chuyenTiep = stateCanSua.transitions || {};
		for (var key in chuyenTiep) {
			var giaTri = chuyenTiep[key];
			if (giaTri == null) continue;

			var stateTiep = futureSm.states[giaTri.state_index];
			if (stateTiep == null) continue; // có khi máy chủ chưa trả state này

			var trackTiep = futureSm.tracks[stateTiep.track];
			sm.tracks.push(trackTiep);
			stateTiep.track = sm.tracks.length - 1;
			stateTiep.state_id = '_future_+' + futureSmId + '+' + stateTiep.state_id;

			sm.states.push(stateTiep);
			chuyenTiep[key].state_index = sm.states.length - 1;
		}

		return [stateCanSua, sm];
	}

	// Hỏi máy chủ Spotify cho state kế tiếp của một state machine. Cần khi quảng cáo
	// nằm gần cuối hàng đợi và mình phải nhìn xa hơn mới tìm được bài thật.
	async function getStates(stateMachineId, startingStateId, soLanThuLai) {
		if (soLanThuLai === undefined) soLanThuLai = 3;

		if (startingStateId && startingStateId.indexOf('future_') !== -1) {
			// Như bản gốc: khớp cả "_future_+..." chứ không chỉ tiền tố đầu chuỗi
			var parts = startingStateId.split('+');
			stateMachineId = parts[1];
			startingStateId = parts[2];
		}

		var url = 'https://spclient.wg.spotify.com/track-playback/v1/devices/' + deviceId + '/state';
		var body = {
			seq_num: 0,
			state_ref: { state_machine_id: stateMachineId, state_id: startingStateId, paused: false },
			sub_state: {
				playback_speed: 1, position: 0, duration: 0,
				stream_time: 0, media_type: 'AUDIO', bitrate: 160000
			},
			previous_position: 0,
			debug_source: 'resume'
		};

		var response = await originalFetch.call(window, url, {
			method: 'PUT',
			headers: {
				Authorization: authorizationHeader || (accessToken ? 'Bearer ' + accessToken : ''),
				'client-token': clientToken || '',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body)
		});

		if (response.status !== 200) {
			if (response.status === 429) {
				canhBao('Spotify đang giới hạn vì nhảy bài quá nhanh. Nghỉ một lát rồi nghe tiếp nhé.');
			}
			throw new Error('Không lấy được state từ Spotify, mã lỗi ' + response.status);
		}

		var data = await response.json();
		if (!data.state_machine) {
			// Thỉnh thoảng máy chủ trả thiếu, thử lại vài lần rồi thôi.
			if (soLanThuLai > 0) return getStates(stateMachineId, startingStateId, soLanThuLai - 1);
			return [null, null];
		}

		return [data.state_machine, data.updated_state_ref];
	}

	// Nhận diện quảng cáo ở tầng state. State "filler" là state chèn thêm cho vui
	// chứ không phải quảng cáo, phải loại ra trước.
	function isAd(state, sm) {
		if (!state) return false;
		if (state.state_id && state.state_id.indexOf('filler') !== -1) return false;
		return isAdTrack(sm.tracks[state.track]);
	}

	function isAdTrack(track) {
		if (!track || !track.metadata) return false;
		if (track.metadata.uri.indexOf(':ad:') !== -1) return true;
		// Ngoài quảng cáo chuẩn của Spotify, áp dụng thêm quy tắc người dùng tự thêm.
		return khopQuyTac(track, 'audio');
	}

	// Phương án cuối: mở khóa tua và đẩy vị trí phát tới tận cuối quảng cáo,
	// khiến nó phát xong ngay lập tức thay vì phải nghe hết.
	function shortenedState(state, track) {
		var duration = Number(track.metadata.duration) || 0;
		state.disallow_seeking = false;
		state.restrictions = {};
		state.initial_playback_position = duration;
		state.position_offset = duration;
		return state;
	}

	function getFutureStateId(stateId) {
		// Như bản gốc: khớp mọi id chứa "future_", bao gồm cả "_future_+..." mà
		// chính mình tạo ra khi ghép state từ máy tương lai.
		if (stateId && stateId.indexOf('future_') !== -1) {
			return stateId.split('+')[2] || stateId;
		}
		return stateId;
	}

	// Ghi chú quan trọng: extension KHÔNG tự vẽ bất cứ thứ gì lên trang Spotify,
	// kể cả thông báo hay cảnh báo - tránh làm phiền và chiếm tài nguyên của trang.
	// Mọi cảnh báo chỉ được đưa về popup của extension để người dùng tự xem.
	// Gửi cảnh báo về popup (qua background). Vẫn giới hạn tần suất để không
	// gửi lặp đi lặp lại cùng một loại cảnh báo làm rối thống kê.
	function canhBao(noiDung) {
		var bayGio = Date.now();
		if (bayGio - lanCanhBaoGanNhat < 60000) return;
		lanCanhBaoGanNhat = bayGio;
		document.dispatchEvent(new CustomEvent('purebeatWarning', {
			detail: { noiDung: noiDung, thoiGian: bayGio }
		}));
	}

	// Báo lên content script mỗi khi chặn được quảng cáo để background ghi vào
	// thống kê (số tổng, loại quảng cáo, phương thức chặn). Mỗi quảng cáo chỉ
	// đếm một lần theo cặp uri + phương thức để số liệu không bị phình.
	var daDem = {};

	function baoQuangCaoBiChan(uri, phuongThuc, ten, loai) {
		var khoa = uri + '|' + phuongThuc;
		if (daDem[khoa]) return;
		daDem[khoa] = true;
		totalAdsRemoved++;
		// Chặn xong là xong, không báo động gì lên trang cả. Số liệu sẽ hiện
		// trong popup và trên badge icon của extension.
		document.dispatchEvent(new CustomEvent('purebeatAdBlocked', {
			detail: {
				uri: uri,
				ten: ten || 'Quảng cáo',
				loai: loai || 'audio',
				phuongThuc: phuongThuc
			}
		}));
	}

	// Lấy tên hiển thị cho quảng cáo: ưu tiên tên nhà quảng cáo, sau đó tới tên track.
	function tenQuangCao(track) {
		if (track && track.metadata) {
			return track.metadata.advertiser || track.metadata.name || track.metadata.uri;
		}
		return '';
	}
})();
