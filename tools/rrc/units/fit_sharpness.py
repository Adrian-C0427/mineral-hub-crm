"""How decisively a lined-up unit outline sits on the well plat's drawing: fit at the chosen
placement vs. the same outline nudged 150 ft (8 directions) or turned +/-2 deg about its center.
fit = share of the outline (inside the sheet) within ~3 px (~10 ft) of colored ink."""
import math
import numpy as np, cv2
from survey_check import sp_to_px


class FitScorer:
    def __init__(self, img_bgr, transform):
        hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
        ink = ((hsv[..., 1] > 90) & (hsv[..., 2] > 70)).astype(np.uint8)
        self.dt = cv2.distanceTransform(1 - ink, cv2.DIST_L2, 5)
        self.t = transform; self.H, self.W = ink.shape

    def fit(self, sp):
        px = sp_to_px(self.t, sp)
        ok = (px[:, 0] >= 0) & (px[:, 0] < self.W - 1) & (px[:, 1] >= 0) & (px[:, 1] < self.H - 1)
        if ok.sum() < 30: return 0.0
        q = px[ok].astype(int)
        return float((self.dt[q[:, 1], q[:, 0]] <= 3).mean())

    def sharpness(self, sp):
        sp = np.asarray(sp, float)
        step = max(1, len(sp) // 1500); sp = sp[::step]
        f0 = self.fit(sp); c = sp.mean(0); alts = []
        for ang in range(0, 360, 45):
            alts.append(self.fit(sp + 150 * np.array([math.cos(math.radians(ang)), math.sin(math.radians(ang))])))
        for d in (-2, 2):
            r = math.radians(d); R = np.array([[math.cos(r), -math.sin(r)], [math.sin(r), math.cos(r)]])
            alts.append(self.fit((sp - c) @ R.T + c))
        m = float(np.mean(alts))
        return f0, (f0 / m if m > 0 else 0.0)
